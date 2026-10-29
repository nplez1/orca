//! Orca's native Windows agent hook, registered as `orca-agent-hook.exe <agent>`: answers
//! `{}`, then posts the hook payload to Orca's loopback listener and waits for the reply,
//! so status events arrive in the order the agent emitted them.
//!
//! Why native: the `.cmd` form costs a cmd.exe start (plus the user's AutoRun) and
//! a curl.exe start on every event, and only an executable runs the same way under
//! Git Bash, PowerShell, and a direct CreateProcess (#20913). The `claude` contract
//! mirrors the managed Windows script in src/main/claude/hook-script.ts.

use std::env;
use std::fs::File;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

// Same caps as the curl form's `--connect-timeout 0.5 --max-time 1.5`.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
const TOTAL_TIMEOUT: Duration = Duration::from_millis(1500);
const ENDPOINT_FILE_BYTE_LIMIT: u64 = 64 * 1024;

/// What one agent's hooks report under, and which of its env vars veto reporting.
struct Agent {
    source: &'static str,
    /// Set means the event is not this pane's to report: exit without owning stdin.
    exit_vars: &'static [&'static str],
}

fn agent(name: &str) -> Option<Agent> {
    match name {
        "claude" => Some(Agent {
            source: "claude",
            // Background sessions inherit pane env (#9236); Grok/Devin replay Claude hooks.
            // Exit before draining: callers may hold stdin open indefinitely (#24907).
            exit_vars: &["CLAUDE_JOB_DIR", "GROK_HOOK_EVENT", "DEVIN_PROJECT_DIR"],
        }),
        _ => None,
    }
}

fn main() {
    let mut stdout = io::stdout();
    // Why first: Claude-compatible permission hooks fail closed on empty stdout (#14818).
    let _ = stdout.write_all(b"{}\r\n");
    let _ = stdout.flush();
    // Why no stdin for an unknown agent: a newer Orca may register one this copy predates.
    if let Some(agent) = env::args_os().nth(1).and_then(|arg| agent(arg.to_str()?)) {
        run(&agent);
    }
    // Why always 0: a hook failure must never block or fail the agent's tool call.
    std::process::exit(0);
}

fn run(agent: &Agent) {
    // Why: refresh the listener coordinates for terminals that survived an Orca restart.
    let endpoint = read_endpoint_file();
    let coordinate = |key: &str| endpoint_value(&endpoint, key).unwrap_or_else(|| var(key));
    let port = coordinate("ORCA_AGENT_HOOK_PORT");
    let token = coordinate("ORCA_AGENT_HOOK_TOKEN");
    // Why (#11549): without Orca's env the hook ran outside an Orca pane, where the caller
    // may abandon stdin; exit before reading it.
    if port.is_empty() || token.is_empty() || var("ORCA_PANE_KEY").is_empty() {
        return;
    }
    let is_set = |name: &&str| !var(name).is_empty();
    if agent.exit_vars.iter().any(is_set) {
        return;
    }
    let mut payload = Vec::new();
    let _ = io::stdin().lock().read_to_end(&mut payload);
    let form = [
        ("paneKey", var("ORCA_PANE_KEY")),
        ("tabId", var("ORCA_TAB_ID")),
        ("launchToken", var("ORCA_AGENT_LAUNCH_TOKEN")),
        ("worktreeId", var("ORCA_WORKTREE_ID")),
        ("env", coordinate("ORCA_AGENT_HOOK_ENV")),
        ("version", coordinate("ORCA_AGENT_HOOK_VERSION")),
        ("agentProcess", agent_process_identity(agent.source).unwrap_or_default()),
    ];
    post(agent.source, &port, &token, &form, &payload);
}

/// The agent process this hook speaks for, as the Windows counterpart of the POSIX `$PPID` capture.
///
/// Why: without it `hasOtherAgentProcessOwner` never fires on Windows, so a nested `claude -p` that
/// posts with a different session looks like the pane's own agent — its `Stop` folds as the pane's
/// completion while the parent's subagents still run (#216 A5).
///
/// Why the nearest ancestor whose image IS the agent, and not the immediate parent: Claude runs the
/// registered command through a shell (`cmd.exe /c`, PowerShell, Git Bash), so the immediate parent is
/// a *new* shell on every hook. That identity would differ between two hooks of one agent, and the
/// receiver would read every later hook as a different owner and drop it — a worse failure than having
/// no identity at all. So the walk only ever names a process whose image matches this hook's own agent,
/// and returns `None` when it cannot find one (a Node-hosted CLI, a renamed binary), which leaves the
/// pane exactly as it is today.
fn agent_process_identity(agent: &str) -> Option<String> {
    let ancestor = ancestor_matching_image(std::process::id(), agent)?;
    // Why the raw creation stamp: the host compares it for equality, and a start time read here and
    // a start time read by a later probe are the same value only if neither is reformatted.
    let start = process_table::creation_stamp(ancestor)?;
    Some(format!(
        "{{\"pid\":{ancestor},\"platform\":\"win32\",\"startTime\":\"{start}\"}}"
    ))
}

/// Bounded so a corrupted parent chain cannot walk the whole machine.
const MAX_ANCESTOR_DEPTH: usize = 8;

/// The closest ancestor whose image base name is `<agent>` or `<agent>.exe`.
fn ancestor_matching_image(own: u32, agent: &str) -> Option<u32> {
    let table = process_table::snapshot()?;
    let mut current = own;
    for _ in 0..MAX_ANCESTOR_DEPTH {
        let parent = table
            .iter()
            .find(|node| node.pid == current)
            .map(|node| node.parent)?;
        // 0 and 1 name no usable process: pid 4's parent is 0, and 1 is not a real Windows pid.
        if parent <= 1 {
            return None;
        }
        let node = table.iter().find(|node| node.pid == parent)?;
        if image_is_agent(&node.image, agent) {
            return Some(parent);
        }
        current = parent;
    }
    None
}

/// `CLAUDE.EXE` and `claude` both name the claude agent; anything else does not.
fn image_is_agent(image: &str, agent: &str) -> bool {
    let stem = match image.rsplit_once('.') {
        Some((stem, extension)) if extension.eq_ignore_ascii_case("exe") => stem,
        _ => image,
    };
    stem.eq_ignore_ascii_case(agent)
}

/// One `kernel32` call each: no crate, keeping this a small std-only utility.
mod process_table {
    use std::ffi::c_void;

    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const MAX_IMAGE_CHARS: usize = 260;

    pub struct ProcessNode {
        pub pid: u32,
        pub parent: u32,
        /// Image base name from the snapshot, empty when the API left it blank.
        pub image: String,
    }

    #[repr(C)]
    struct ProcessEntry32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; MAX_IMAGE_CHARS],
    }

    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> *mut c_void;
        fn Process32FirstW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> *mut c_void;
        fn GetProcessTimes(
            process: *mut c_void,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    fn invalid_handle() -> *mut c_void {
        -1isize as *mut c_void
    }

    /// Every live process with its parent and image name; `None` when the snapshot cannot be taken.
    pub fn snapshot() -> Option<Vec<ProcessNode>> {
        // SAFETY: the snapshot handle is validated and closed, and `entry` is a zeroed
        // PROCESSENTRY32W with `dw_size` set to its own size, which is what the API requires.
        unsafe {
            let handle = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if handle.is_null() || handle == invalid_handle() {
                return None;
            }
            let mut entry: ProcessEntry32W = std::mem::zeroed();
            entry.dw_size = std::mem::size_of::<ProcessEntry32W>() as u32;
            let mut nodes = Vec::new();
            let mut more = Process32FirstW(handle, &mut entry) != 0;
            while more {
                nodes.push(ProcessNode {
                    pid: entry.th32_process_id,
                    parent: entry.th32_parent_process_id,
                    image: utf16_name(&entry.sz_exe_file),
                });
                more = Process32NextW(handle, &mut entry) != 0;
            }
            CloseHandle(handle);
            Some(nodes)
        }
    }

    /// The NUL-terminated UTF-16 base name; invalid units become replacement characters, which cannot
    /// match an agent name and so can only turn a report into no report.
    fn utf16_name(units: &[u16; MAX_IMAGE_CHARS]) -> String {
        let len = units.iter().position(|unit| *unit == 0).unwrap_or(units.len());
        String::from_utf16_lossy(&units[..len])
    }

    /// The process creation time as a single comparable number.
    pub fn creation_stamp(pid: u32) -> Option<u64> {
        // SAFETY: the handle is validated before use and closed on both paths.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return None;
            }
            let mut creation = FileTime::default();
            let mut exit = FileTime::default();
            let mut kernel = FileTime::default();
            let mut user = FileTime::default();
            let ok = GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) != 0;
            CloseHandle(handle);
            if !ok || (creation.high == 0 && creation.low == 0) {
                return None;
            }
            Some((u64::from(creation.high) << 32) | u64::from(creation.low))
        }
    }
}

fn var(name: &str) -> String {
    env::var_os(name)
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The file src/shared/agent-hook-listener/endpoint-publication.ts writes, or "" if unreadable.
fn read_endpoint_file() -> String {
    let mut text = String::new();
    let read = File::open(var("ORCA_AGENT_HOOK_ENDPOINT")).and_then(|file| {
        file.take(ENDPOINT_FILE_BYTE_LIMIT)
            .read_to_string(&mut text)
    });
    if read.is_err() {
        text.clear();
    }
    text
}

/// The last `set KEY=VALUE` for `key`, as `call` would leave it; `lines` strips the CRLF.
fn endpoint_value(text: &str, key: &str) -> Option<String> {
    text.lines().rev().find_map(|line| {
        let assignment = line
            .get(..4)
            .filter(|prefix| prefix.eq_ignore_ascii_case("set "))
            .and(line.get(4..))?;
        let (name, value) = assignment.split_once('=')?;
        (name == key).then(|| value.to_string())
    })
}

fn post(source: &str, port: &str, token: &str, form: &[(&str, String)], payload: &[u8]) {
    let Ok(port) = port.parse::<u16>() else {
        return;
    };
    // A header value cannot carry control characters; such a token never authenticates anyway.
    if port == 0 || token.bytes().any(|byte| byte < 0x20 || byte == 0x7f) {
        return;
    }
    let mut body = Vec::with_capacity(payload.len() * 3 / 2 + 512);
    for (name, value) in form {
        append_form_field(&mut body, name, value.as_bytes());
        body.push(b'&');
    }
    append_form_field(&mut body, "payload", payload);
    let mut request = format!(
        "POST /hook/{source} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
         Content-Type: application/x-www-form-urlencoded\r\n\
         X-Orca-Agent-Hook-Token: {token}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    request.extend_from_slice(&body);

    let deadline = Instant::now() + TOTAL_TIMEOUT;
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) else {
        return;
    };
    // Why wait for the reply: the listener applies the event before answering, and an exit
    // before that would let the agent's next event overtake this one.
    if arm(&stream, deadline) && stream.write_all(&request).is_ok() && arm(&stream, deadline) {
        let _ = io::copy(&mut stream, &mut io::sink());
    }
}

/// Bounds the next socket calls by what is left of the deadline; false once it has passed.
fn arm(stream: &TcpStream, deadline: Instant) -> bool {
    let remaining = deadline.saturating_duration_since(Instant::now());
    !remaining.is_zero()
        && stream.set_read_timeout(Some(remaining)).is_ok()
        && stream.set_write_timeout(Some(remaining)).is_ok()
}

/// `name=value` with the value percent-encoded exactly as curl's `--data-urlencode` does.
fn append_form_field(body: &mut Vec<u8>, name: &str, value: &[u8]) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    body.extend_from_slice(name.as_bytes());
    body.push(b'=');
    for &byte in value {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            body.push(byte);
        } else {
            body.extend_from_slice(&[
                b'%',
                HEX[usize::from(byte >> 4)],
                HEX[usize::from(byte & 15)],
            ]);
        }
    }
}
