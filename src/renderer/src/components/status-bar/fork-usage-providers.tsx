import React from 'react'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { hasCreditsData } from './provider-credits-format'

// Why: the official DeepSeek whale, taken verbatim from deepseek.com. It is a single
// currentColor path, so it inlines like the Claude/OpenAI marks and inherits the
// surrounding text colour rather than hardcoding a brand blue that would disappear
// on one of the two themes.
const DEEPSEEK_WHALE_PATH =
  'M26.5174 3.39471C26.235 3.2567 26.1137 3.52006 25.9487 3.65346C25.8923 3.69659 25.8446 3.75294 25.7969 3.80469C25.3846 4.24516 24.9027 4.53439 24.2737 4.49989C23.3536 4.44814 22.5682 4.73737 21.8735 5.44119C21.7258 4.57349 21.2353 4.0554 20.4889 3.72304C20.0985 3.55054 19.7034 3.37746 19.4297 3.00197C19.2388 2.73459 19.1865 2.43673 19.091 2.14289C19.0301 1.96579 18.9697 1.78466 18.7656 1.75418C18.5442 1.71968 18.4574 1.90541 18.3705 2.06067C18.0232 2.69549 17.8887 3.39471 17.9019 4.10313C17.9324 5.6965 18.6051 6.96556 19.9421 7.86834C20.0939 7.97184 20.133 8.07535 20.0852 8.22658C19.9938 8.53766 19.8857 8.83955 19.7903 9.15063C19.7293 9.34901 19.6384 9.39271 19.4257 9.30588C18.692 8.9994 18.0583 8.54571 17.4982 7.99772C16.5477 7.07827 15.6881 6.06336 14.6162 5.26869C14.3644 5.08296 14.1125 4.91045 13.8521 4.746C12.7584 3.68394 13.9952 2.81164 14.2816 2.70814C14.5812 2.60003 14.3857 2.22857 13.4179 2.23317C12.4502 2.2372 11.5646 2.56151 10.4359 2.99335C10.2708 3.05832 10.0972 3.10547 9.91951 3.14457C8.8954 2.95022 7.83162 2.90709 6.72069 3.03245C4.62877 3.26533 2.95777 4.25436 1.72954 5.94261C0.254043 7.97184 -0.0932678 10.2777 0.33167 12.6824C0.778458 15.2171 2.07225 17.3153 4.06008 18.9558C6.12152 20.6567 8.49577 21.4905 11.2047 21.3306C12.8498 21.2358 14.6812 21.0155 16.7473 19.2669C17.2682 19.5262 17.8151 19.6297 18.7219 19.7074C19.4205 19.7723 20.0933 19.6729 20.6143 19.5648C21.4302 19.3923 21.3739 18.6367 21.0789 18.4981C18.6874 17.3843 19.2124 17.8374 18.7351 17.4706C19.9501 16.033 21.8063 13.4776 22.379 9.99821C22.4353 9.61409 22.5072 9.073 22.4986 8.76192C22.494 8.57216 22.5377 8.49856 22.7545 8.47671C23.3536 8.40771 23.935 8.24383 24.4692 7.94999C26.0188 7.10357 26.6439 5.71318 26.7911 4.04678C26.8129 3.79204 26.7865 3.52869 26.5174 3.39471ZM13.0143 18.3946C10.6964 16.5724 9.5722 15.9726 9.10816 15.9985C8.67402 16.0244 8.75222 16.5212 8.84768 16.8449C8.94773 17.1646 9.07768 17.3849 9.25996 17.6655C9.38589 17.8512 9.47272 18.1272 9.13404 18.3348C8.38766 18.7965 7.08985 18.1796 7.0289 18.1491C5.51833 17.2595 4.25559 16.0853 3.36546 14.4793C2.50581 12.9337 2.0067 11.2753 1.92447 9.50542C1.90262 9.07818 2.02855 8.92695 2.45406 8.84932C3.01413 8.74582 3.59144 8.72397 4.15093 8.80619C6.51656 9.15178 8.53027 10.2092 10.2185 11.8848C11.1822 12.8388 11.9114 13.979 12.6623 15.0929C13.461 16.2757 14.3201 17.4027 15.4144 18.3268C15.8008 18.6505 16.109 18.8966 16.404 19.0783C15.5144 19.1778 14.0297 19.1991 13.0143 18.3958V18.3946ZM14.1252 11.2489C14.1252 11.0591 14.277 10.9079 14.4679 10.9079C14.511 10.9079 14.5501 10.9165 14.5852 10.9292C14.6329 10.9464 14.6766 10.9723 14.7111 11.0114C14.7721 11.0718 14.8066 11.158 14.8066 11.2489C14.8066 11.4386 14.6548 11.5899 14.4639 11.5899C14.273 11.5899 14.1252 11.4386 14.1252 11.2489ZM17.5759 13.0188C17.3545 13.1096 17.1331 13.1873 16.9203 13.1959C16.5903 13.2131 16.2303 13.0791 16.0348 12.9153C15.7312 12.6605 15.5139 12.5179 15.423 12.0734C15.3839 11.8837 15.4057 11.5899 15.4402 11.4214C15.5185 11.0585 15.4316 10.8257 15.1757 10.614C14.9676 10.4415 14.7025 10.3938 14.4115 10.3938C14.3029 10.3938 14.2034 10.3461 14.1292 10.3076C14.0079 10.2472 13.9078 10.096 14.0033 9.91023C14.0338 9.84985 14.1815 9.70322 14.216 9.67734C14.6111 9.45251 15.0665 9.52612 15.488 9.6946C15.8784 9.85445 16.174 10.1477 16.5989 10.5623C17.033 11.0631 17.1112 11.2011 17.3585 11.5772C17.554 11.871 17.7317 12.1729 17.8536 12.5185C17.9272 12.7341 17.8317 12.9107 17.5759 13.0188Z'

export function DeepSeekIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  // Why: the mark is 26.634x19.6 (wider than tall); a square box would squash the whale.
  const height = Math.round((size * 19.6) / 26.634)
  return (
    <svg
      width={size}
      height={height}
      viewBox="0.163086 1.75 26.634 19.6"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d={DEEPSEEK_WHALE_PATH} fill="currentColor" />
    </svg>
  )
}

// Why: the official Fireworks mark, taken verbatim from the SVG icon fireworks.ai
// serves as its favicon (three paths on a 32x32 grid, all brand purple). Inlined
// like the Claude/Gemini marks rather than shipped as a resources/ asset, because a
// single fixed fill colour needs no separate file.
//
// The viewBox is cropped from the source's 32x32 to the mark's own bounds (y 8-23.8)
// and the width is scaled past `size`: their icon grid carries ~25% vertical padding
// and the mark itself is 2:1, so at the same width as the whale it rendered ~35%
// shorter and read as a smaller icon than its neighbours.
// Why the swatch is hardcoded: the purple is part of the official mark, the same way the Claude
// orange (#D97757) and the Gemini mark are baked in below. currentColor would inherit the
// surrounding text colour and lose the identity the mark exists to carry.
export function FireworksIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  const width = Math.round(size * 1.25)
  const height = Math.round((width * 15.8065) / 32)
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 8 32 15.8065"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M15.9851 19.1274C15.0969 19.1274 14.2999 18.6001 13.96 17.7838L9.86258 8H12.2608L15.9991 16.9499L19.7339 8H22.1321L18.0102 17.7873C17.6686 18.6001 16.8733 19.1274 15.9851 19.1274Z"
        fill="#6720FF"
      />
      <path
        d="M21.3316 23.8029C20.4469 23.8029 19.6533 23.2792 19.31 22.4698C18.9649 21.6535 19.1436 20.7215 19.7672 20.0891L27.2299 12.5302L28.1618 14.7287L21.3298 21.636L31.068 21.5817L32 23.7802L21.3333 23.8065L21.3298 23.8029H21.3316Z"
        fill="#6720FF"
      />
      <path
        d="M0 23.7766L0.931955 21.5781L10.6702 21.6324L3.83993 14.7234L4.77189 12.5249L12.2345 20.0838C12.8582 20.7145 13.0386 21.65 12.6918 22.4645C12.3484 23.2756 11.5513 23.7977 10.6702 23.7977L0.00350359 23.7731L0 23.7766Z"
        fill="#6720FF"
      />
    </svg>
  )
}

// Why: the official GitHub Copilot mark, taken verbatim from the brand icon GitHub
// ships for the product. A single currentColor path, so it inlines like the OpenAI and
// DeepSeek marks and inherits the surrounding text colour on either theme.
const COPILOT_MARK_PATH =
  'M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z'

export function CopilotIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d={COPILOT_MARK_PATH} fill="currentColor" />
    </svg>
  )
}

// Why: the official DeepInfra mark, taken verbatim from the logo SVG deepinfra.com serves in its
// own header. That source is one path carrying both the 3x3 dot-grid mark and the "deepinfra"
// wordmark on a 174x32 grid, so the viewBox crops to the mark's own bounds and the wordmark falls
// outside it. currentColor, like the DeepSeek whale: the source paints the lockup white for
// DeepInfra's dark header, which would vanish on the light theme.
const DEEPINFRA_MARK_PATH =
  'M2.833 10.66A2.837 2.837 0 0 1 0 7.825a2.837 2.837 0 0 1 2.833-2.834 2.837 2.837 0 0 1 2.834 2.834 2.837 2.837 0 0 1-2.834 2.833m0-4.555a1.723 1.723 0 0 0 0 3.445 1.724 1.724 0 0 0 0-3.445m0 12.552A2.837 2.837 0 0 1 0 15.822a2.837 2.837 0 0 1 2.833-2.834 2.837 2.837 0 0 1 2.834 2.834 2.837 2.837 0 0 1-2.834 2.833m0-4.554a1.722 1.722 0 0 0 0 3.443 1.722 1.722 0 1 0 0-3.443m0 12.539A2.837 2.837 0 0 1 0 23.806a2.837 2.837 0 0 1 2.833-2.833 2.837 2.837 0 0 1 2.834 2.833 2.837 2.837 0 0 1-2.834 2.834m0-4.555a1.723 1.723 0 0 0 0 3.445c.95 0 1.723-.772 1.723-1.722s-.772-1.723-1.723-1.723M24.376 10.66a2.837 2.837 0 0 1-2.833-2.834 2.837 2.837 0 0 1 2.833-2.834 2.837 2.837 0 0 1 2.834 2.834 2.837 2.837 0 0 1-2.834 2.833m0-4.555c-.948 0-1.722.772-1.722 1.722a1.724 1.724 0 0 0 3.445 0c0-.95-.772-1.722-1.723-1.722m0 12.551a2.837 2.837 0 0 1-2.833-2.833 2.837 2.837 0 0 1 2.833-2.834 2.837 2.837 0 0 1 2.834 2.834 2.837 2.837 0 0 1-2.834 2.833m0-4.554c-.948 0-1.722.772-1.722 1.72 0 .95.772 1.723 1.722 1.723s1.723-.772 1.723-1.722-.772-1.721-1.723-1.721m0 12.539a2.837 2.837 0 0 1-2.833-2.834 2.837 2.837 0 0 1 2.833-2.833 2.837 2.837 0 0 1 2.834 2.833 2.837 2.837 0 0 1-2.834 2.834m0-4.555a1.724 1.724 0 1 0 1.723 1.723c0-.95-.772-1.723-1.723-1.723m-10.771-7.43a2.837 2.837 0 0 1-2.834-2.833 2.837 2.837 0 0 1 2.834-2.834 2.837 2.837 0 0 1 2.833 2.834 2.837 2.837 0 0 1-2.833 2.833m0-4.554c-.949 0-1.723.772-1.723 1.722s.773 1.723 1.723 1.723 1.723-.772 1.723-1.723c0-.95-.773-1.722-1.723-1.722m0-3.434a2.837 2.837 0 0 1-2.834-2.834A2.837 2.837 0 0 1 13.606 1a2.837 2.837 0 0 1 2.833 2.833 2.837 2.837 0 0 1-2.833 2.834m0-4.554c-.949 0-1.723.772-1.723 1.722a1.724 1.724 0 0 0 3.446 0c0-.95-.773-1.722-1.723-1.722m-.001 20.534a2.837 2.837 0 0 1-2.834-2.833 2.837 2.837 0 0 1 2.834-2.834 2.837 2.837 0 0 1 2.833 2.834 2.837 2.837 0 0 1-2.833 2.833m0-4.554a1.724 1.724 0 0 0 0 3.445 1.724 1.724 0 0 0 0-3.445m0 12.547a2.837 2.837 0 0 1-2.834-2.834 2.837 2.837 0 0 1 2.834-2.833 2.837 2.837 0 0 1 2.833 2.833 2.837 2.837 0 0 1-2.833 2.834m0-4.555a1.724 1.724 0 1 0 1.723 1.723c0-.95-.773-1.723-1.723-1.723M9.094 11.154a.9.9 0 0 1-.342-.066l-1.845-.735a.926.926 0 1 1 .687-1.72l1.845.735a.926.926 0 0 1-.344 1.786zm0 7.835a.9.9 0 0 1-.342-.066l-1.845-.735a.925.925 0 1 1 .687-1.72l1.845.736a.925.925 0 0 1-.344 1.785zm10.82-3.914a.9.9 0 0 1-.342-.066l-1.844-.735a.926.926 0 0 1 .685-1.72l1.845.736a.926.926 0 0 1-.344 1.785m0-7.835a.9.9 0 0 1-.342-.066l-1.844-.735a.926.926 0 0 1 .685-1.72l1.845.735a.926.926 0 0 1-.344 1.786m0 15.668a.9.9 0 0 1-.342-.066l-1.844-.735a.926.926 0 0 1 .685-1.72l1.845.735a.926.926 0 0 1-.344 1.785m-12.616.281a.926.926 0 0 1-.344-1.785l1.845-.735a.925.925 0 1 1 .687 1.72l-1.845.734a.9.9 0 0 1-.342.066zm0-7.793a.926.926 0 0 1-.344-1.785l1.845-.735a.925.925 0 1 1 .687 1.72l-1.845.734a.9.9 0 0 1-.342.066zm0-8.18a.926.926 0 0 1-.344-1.785L8.8 4.695a.925.925 0 1 1 .687 1.72L7.64 7.15a.9.9 0 0 1-.342.065zm1.796 20.169a.9.9 0 0 1-.342-.066l-1.845-.735a.925.925 0 0 1 .686-1.72l1.844.736a.926.926 0 0 1-.343 1.785m8.976-16.229a.926.926 0 0 1-.344-1.787l1.844-.735a.927.927 0 0 1 .687 1.72l-1.844.736a.9.9 0 0 1-.342.066zm0 7.835a.926.926 0 0 1-.344-1.786l1.844-.736a.927.927 0 0 1 .687 1.721l-1.844.736a.9.9 0 0 1-.342.066zm0 8.393a.925.925 0 0 1-.343-1.785l1.843-.735a.925.925 0 1 1 .686 1.72l-1.845.735a.9.9 0 0 1-.342.065M49.146 1v23.347h-3.475l-.244-2.073c-1.16 1.8-3.018 2.408-4.847 2.408-4.421 0-7.744-2.926-7.744-7.864 0-5.183 3.262-7.865 7.653-7.865 1.584 0 4.055.854 4.938 2.408V3.039l3.72-2.037zm-12.59 15.816c0 2.622 1.889 4.421 4.268 4.421 2.38 0 4.36-1.708 4.36-4.421s-2.011-4.39-4.36-4.39-4.268 1.677-4.268 4.39m19.329 1.342c.244 1.859 1.859 3.2 4.48 3.2 1.373 0 3.17-.518 4.025-1.402l2.377 2.347c-1.586 1.645-4.177 2.438-6.463 2.438-5.182 0-8.261-3.201-8.261-8.017s3.11-7.865 7.988-7.865 8.17 3.11 7.59 9.299zm8.17-3.08c-.245-1.95-1.768-2.926-3.903-2.926-2.012 0-3.659.976-4.208 2.927h8.11m9.604 3.079c.244 1.859 1.859 3.2 4.48 3.2 1.373 0 3.171-.518 4.025-1.402l2.378 2.347c-1.586 1.645-4.177 2.438-6.463 2.438-5.183 0-8.262-3.201-8.262-8.017s3.11-7.865 7.989-7.865 8.17 3.11 7.59 9.299zm8.17-3.08c-.244-1.95-1.768-2.926-3.903-2.926-2.011 0-3.659.976-4.208 2.927h8.111m6.434 15.546V9.316l3.72 2.073c1.158-1.676 3.17-2.409 4.876-2.409 4.635 0 7.714 3.446 7.714 7.865s-2.774 7.866-7.592 7.866c-1.584 0-3.933-.488-4.999-2.133v8.047zm12.59-13.78c0-2.347-1.584-4.267-4.268-4.267s-4.269 1.92-4.269 4.267 1.739 4.269 4.269 4.269 4.268-1.92 4.268-4.269M111.367 3.64c0 2.897-4.39 2.897-4.39 0 0-2.895 4.39-2.895 4.39 0m-.335 5.614h-3.72v15.09h3.72zm14.42 15.094v-7.865c0-2.286-1.251-4.025-3.628-4.025s-3.842 1.92-3.842 4.208v7.683h-3.689V9.288l3.567 2.042c1.525-1.495 3.049-2.256 4.938-2.256 3.537 0 6.372 2.652 6.372 7.378v7.897h-3.72zm8.14-.001V12.793h-2.805V9.53h2.805V8.524c0-4.024 2.713-5.883 5.731-5.883 1.311 0 2.682.427 3.902 1.22l-1.372 2.774c-.793-.519-1.525-.793-2.286-.793-1.281 0-2.256.854-2.256 2.682v1.007h4.421v3.262h-4.421v11.554zm14.481-13.292c1.159-1.86 2.713-2.133 4.238-2.133s3.049.61 3.872 1.433l-1.677 3.232c-.763-.64-1.464-.976-2.683-.976-1.95 0-3.75 1.037-3.75 3.811v7.926h-3.719V9.318l3.719 1.739zm21.308.331 3.689-2.072v15.03h-3.506l-.183-2.195c-.854 1.767-3.201 2.621-4.877 2.652-4.451.03-7.742-2.713-7.742-7.987 0-5.273 3.445-7.897 7.834-7.864 2.011 0 3.933.945 4.785 2.438zm-8.901 5.427c0 2.865 1.981 4.573 4.45 4.573 5.853 0 5.853-9.115 0-9.115-2.469 0-4.45 1.676-4.45 4.543'

export function DeepInfraIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  // Why: the mark is 27.21x21.65 — wider than tall — so a square box would squash the dot grid.
  const height = Math.round((size * 21.65) / 27.21)
  return (
    <svg
      width={size}
      height={height}
      viewBox="0 4.99 27.21 21.65"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d={DEEPINFRA_MARK_PATH} fill="currentColor" />
    </svg>
  )
}

export type ForkUsageProviderId = 'deepseek' | 'fireworks' | 'deepinfra' | 'copilot'

export type ForkUsageProviderSettings = {
  /** Widened to string so any provider id (including Kimi/Antigravity) can be checked. */
  disabledUsageProviders?: readonly string[]
  // Why: DeepSeek/Fireworks credentials are API keys stored outside GlobalSettings;
  // main derives these booleans each poll and the renderer never sees the key.
  deepseekApiKeyConfigured: boolean
  fireworksApiKeyConfigured: boolean
  // Why: the DeepInfra key lives in the same kind of encrypted store, so its
  // presence arrives the same way.
  deepinfraApiKeyConfigured: boolean
  // Why: the Copilot token and enterprise slug also live outside GlobalSettings.
  copilotTokenConfigured: boolean
}

export type ForkUsageProviderSnapshots = {
  deepseek: ProviderRateLimits | null | undefined
  fireworks: ProviderRateLimits | null | undefined
  deepinfra: ProviderRateLimits | null | undefined
  copilot: ProviderRateLimits | null | undefined
}

type ForkUsageProviderEntry = {
  label: string
  badgeLetter: string
  Icon: (props: { size?: number }) => React.JSX.Element
  settingsFlag: Exclude<keyof ForkUsageProviderSettings, 'disabledUsageProviders'>
  pendingReadout: Partial<ProviderRateLimits>
  hasData: (provider: ProviderRateLimits) => boolean
}

export const FORK_USAGE_PROVIDERS: Record<ForkUsageProviderId, ForkUsageProviderEntry> = {
  deepseek: {
    label: 'DeepSeek',
    badgeLetter: 'D',
    Icon: DeepSeekIcon,
    settingsFlag: 'deepseekApiKeyConfigured',
    // Why: DeepSeek has no windows; its readout is the credits field.
    pendingReadout: { credits: null },
    hasData: hasCreditsData
  },
  fireworks: {
    label: 'Fireworks.ai',
    badgeLetter: 'F',
    Icon: FireworksIcon,
    settingsFlag: 'fireworksApiKeyConfigured',
    // Why: Fireworks has no windows; its readout is the credits field.
    pendingReadout: { credits: null },
    hasData: hasCreditsData
  },
  deepinfra: {
    label: 'DeepInfra',
    badgeLetter: 'I',
    Icon: DeepInfraIcon,
    settingsFlag: 'deepinfraApiKeyConfigured',
    // Why: DeepInfra has no windows; its readout is the remaining balance.
    pendingReadout: { credits: null },
    hasData: hasCreditsData
  },
  copilot: {
    // Why: a brand label, like upstream's own provider names in usage-error-copy.ts; the
    // localization checker's allowlist carries the reviewed exclusion.
    label: 'GitHub Copilot',
    badgeLetter: 'P',
    Icon: CopilotIcon,
    settingsFlag: 'copilotTokenConfigured',
    // Why: Copilot reports a monthly allowance rather than a quota window.
    pendingReadout: { monthly: null, allowance: null },
    // Why not `hasUsageData`: that module imports this one, so reusing it would cycle. The allowance is
    // Copilot's own readout, so it is the field that has to be present before the row counts as data.
    hasData: (provider) => provider.allowance != null
  }
}

export const FORK_USAGE_PROVIDER_IDS: readonly ForkUsageProviderId[] = [
  'deepseek',
  'fireworks',
  'deepinfra',
  'copilot'
]

export function isForkUsageProvider(provider: string): provider is ForkUsageProviderId {
  return (
    provider === 'deepseek' ||
    provider === 'fireworks' ||
    provider === 'deepinfra' ||
    provider === 'copilot'
  )
}

export function forkUsageHasData(provider: ProviderRateLimits): boolean {
  return (
    isForkUsageProvider(provider.provider) &&
    FORK_USAGE_PROVIDERS[provider.provider].hasData(provider)
  )
}
