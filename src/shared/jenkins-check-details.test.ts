import { describe, expect, it } from 'vitest'
import type { PRCheckDetail } from './github/check-types'
import { jenkinsBuildToCheckRunDetails } from './jenkins-check-details'
import type { JenkinsBuildLocation } from './jenkins-urls'

const location: Pick<JenkinsBuildLocation, 'jobPath' | 'buildUrl'> = {
  jobPath: ['team', 'repo', 'main'],
  buildUrl: 'https://ci.example.com/job/team/job/repo/job/main/12/'
}

const check: Pick<PRCheckDetail, 'name' | 'status' | 'conclusion' | 'url'> = {
  name: 'continuous-integration/jenkins/pr-merge',
  status: 'completed',
  conclusion: 'failure',
  url: 'https://ci.example.com/job/team/job/repo/job/main/12/display/redirect'
}

const failedBuild = {
  number: 12,
  building: false,
  result: 'FAILURE',
  displayName: '#12',
  fullDisplayName: 'team » repo » main #12',
  description: null,
  timestamp: 1_700_000_000_000,
  duration: 61_000,
  estimatedDuration: 55_000,
  actions: [
    {
      _class: 'hudson.model.CauseAction',
      causes: [
        { _class: 'hudson.model.Cause$UserIdCause', shortDescription: 'Started by user Ada' }
      ]
    },
    {
      _class: 'hudson.model.ParametersAction',
      parameters: [
        { _class: 'hudson.model.StringParameterValue', name: 'BRANCH', value: 'main' },
        {
          _class: 'hudson.model.PasswordParameterValue',
          name: 'REGISTRY_PASSWORD',
          value: 'hunter2'
        },
        { _class: 'hudson.model.StringParameterValue', name: 'GITHUB_TOKEN', value: 'ghp_secret' }
      ]
    }
  ],
  changeSets: [
    {
      _class: 'hudson.plugins.git.GitChangeSetList',
      items: [
        {
          commitId: 'abc123',
          msg: 'Fix the thing',
          author: { fullName: 'Ada Lovelace' }
        }
      ]
    }
  ]
}

const failedStages = {
  id: '12',
  name: '#12',
  status: 'FAILED',
  startTimeMillis: 1_700_000_000_000,
  endTimeMillis: 1_700_000_060_000,
  durationMillis: 60_000,
  queueDurationMillis: 1_500,
  stages: [
    {
      id: '3',
      name: 'Checkout',
      status: 'SUCCESS',
      startTimeMillis: 1_700_000_000_000,
      durationMillis: 4_000
    },
    {
      id: '7',
      name: 'Test',
      status: 'FAILED',
      startTimeMillis: 1_700_000_004_000,
      durationMillis: 56_000
    },
    { id: '9', name: 'Deploy', status: 'NOT_EXECUTED' }
  ]
}

describe('jenkinsBuildToCheckRunDetails', () => {
  it('carries the build metadata, links and stage list of a failed pipeline build', () => {
    const details = jenkinsBuildToCheckRunDetails({
      check,
      location,
      build: failedBuild,
      stages: failedStages
    })

    // Why the row's state, not Jenkins': the list row and the pane must agree, or the pane's
    // cached entry is evicted on every poll.
    expect(details.status).toBe('completed')
    expect(details.conclusion).toBe('failure')
    expect(details.title).toBe('team » repo » main #12')
    expect(details.url).toBe(location.buildUrl)
    expect(details.detailsUrl).toBe(location.buildUrl)
    expect(details.startedAt).toBe('2023-11-14T22:13:20.000Z')
    expect(details.completedAt).toBe('2023-11-14T22:14:20.000Z')
    expect(details.build).toEqual({
      number: '12',
      queuedMs: 1_500,
      estimatedDurationMs: 55_000,
      triggeredBy: 'Started by user Ada',
      parameters: [
        { name: 'BRANCH', value: 'main', secret: false },
        { name: 'REGISTRY_PASSWORD', value: '••••', secret: true },
        { name: 'GITHUB_TOKEN', value: '••••', secret: true }
      ],
      commits: [{ id: 'abc123', message: 'Fix the thing', author: 'Ada Lovelace' }]
    })
  })

  it('lists every stage so the running or failed one is visible', () => {
    const details = jenkinsBuildToCheckRunDetails({
      check,
      location,
      build: failedBuild,
      stages: failedStages
    })
    const job = details.jobs[0]

    expect(job.stepRendering).toBe('all')
    expect(job.name).toBe('#12')
    expect(job.id).toBe(12)
    expect(job.status).toBe('completed')
    expect(job.conclusion).toBe('failure')
    expect(job.steps.map((step) => [step.name, step.status, step.conclusion])).toEqual([
      ['Checkout', 'completed', 'success'],
      ['Test', 'completed', 'failure'],
      ['Deploy', 'completed', 'skipped']
    ])
    expect(job.steps[1].startedAt).toBe('2023-11-14T22:13:24.000Z')
    expect(job.steps[1].completedAt).toBe('2023-11-14T22:14:20.000Z')
  })

  it('nests each stage’s steps and carries the failure text from its own detail', () => {
    const details = jenkinsBuildToCheckRunDetails({
      check,
      location,
      build: failedBuild,
      stages: failedStages,
      stageDetails: [
        {
          id: '3',
          name: 'Checkout',
          status: 'SUCCESS',
          stageFlowNodes: [{ id: '4', name: 'Git', status: 'SUCCESS' }]
        },
        {
          id: '7',
          name: 'Test',
          status: 'FAILED',
          stageFlowNodes: [
            {
              id: '9',
              name: 'Shell Script',
              status: 'FAILED',
              error: { message: 'script returned exit code 1' }
            }
          ]
        },
        // A stage whose detail was not fetched must stay a leaf, not look like an empty stage.
        null
      ]
    })

    const steps = details.jobs[0].steps
    // The Jenkins node id survives so React keys stay unique even when a stage name repeats.
    expect(steps[0].id).toBe('3')
    expect(steps[1].id).toBe('7')
    expect(steps[1].children?.[0].id).toBe('9')
    expect(steps[0].children?.map((child) => child.name)).toEqual(['Git'])
    expect(steps[1].children?.map((child) => child.name)).toEqual(['Shell Script'])
    expect(steps[1].children?.[0].errorMessage).toBe('script returned exit code 1')
    // The stage-level message lets the failure summary explain the build without walking children.
    expect(steps[1].errorMessage).toBe('script returned exit code 1')
    expect(steps[2].children).toBeUndefined()
    expect(steps[2].errorMessage).toBeUndefined()
  })

  it('reads a running build, including a stage paused for input', () => {
    const details = jenkinsBuildToCheckRunDetails({
      check: { ...check, status: 'in_progress', conclusion: 'pending' },
      location,
      build: {
        number: 13,
        building: true,
        result: null,
        duration: 0,
        timestamp: 1_700_000_000_000
      },
      stages: {
        startTimeMillis: 1_700_000_000_000,
        queueDurationMillis: 900,
        stages: [
          { name: 'Test', status: 'IN_PROGRESS', startTimeMillis: 1_700_000_000_000 },
          { name: 'Approve', status: 'PAUSED_PENDING_INPUT' },
          { name: 'Ship', status: 'UNSTABLE' }
        ]
      }
    })

    expect(details.jobs[0].status).toBe('in_progress')
    expect(details.jobs[0].conclusion).toBe('pending')
    expect(details.completedAt).toBeNull()
    expect(details.jobs[0].steps.map((step) => [step.name, step.status, step.conclusion])).toEqual([
      ['Test', 'in_progress', 'pending'],
      // Why: input-waiting has not completed, and its status has to say so.
      ['Approve', 'in_progress', 'action_required'],
      // Why: UNSTABLE is not a pass, and neither neutral nor skipped would send anyone to look.
      ['Ship', 'completed', 'failure']
    ])
    // Why: wfapi reports elapsed time for a stage still running, which is not a completion.
    expect(details.jobs[0].steps[0].completedAt).toBeNull()
    expect(details.jobs[0].steps[1].completedAt).toBeNull()
  })

  it('keeps a freestyle build useful without a stage list', () => {
    const details = jenkinsBuildToCheckRunDetails({
      check,
      location,
      build: { number: 4, building: false, result: 'UNSTABLE', displayName: '#4' },
      stages: null
    })

    expect(details.jobs).toHaveLength(1)
    expect(details.jobs[0].steps).toEqual([])
    expect(details.jobs[0].stepRendering).toBeUndefined()
    expect(details.jobs[0].conclusion).toBe('failure')
    expect(details.jobs[0].name).toBe('#4')
    expect(details.build?.number).toBe('4')
  })

  it('falls back to the job path when Jenkins omits a display name', () => {
    const details = jenkinsBuildToCheckRunDetails({
      check,
      location,
      build: { number: 4, building: false, result: 'ABORTED' },
      stages: null
    })

    expect(details.jobs[0].name).toBe('#4')
    expect(details.jobs[0].conclusion).toBe('cancelled')
    expect(
      jenkinsBuildToCheckRunDetails({ check, location, build: {}, stages: null }).jobs[0].name
    ).toBe('team / repo / main')
  })

  it('links to the build it read, not to a moving permalink', () => {
    const details = jenkinsBuildToCheckRunDetails({
      check: { ...check, url: 'https://ci.example.com/job/team/job/repo/lastBuild/' },
      location: {
        jobPath: ['team', 'repo'],
        buildUrl: 'https://ci.example.com/job/team/job/repo/lastBuild/'
      },
      build: {
        number: 12,
        building: false,
        result: 'FAILURE',
        url: 'https://ci.example.com/job/team/job/repo/12/'
      },
      stages: null
    })

    expect(details.url).toBe('https://ci.example.com/job/team/job/repo/12/')
    expect(details.detailsUrl).toBe('https://ci.example.com/job/team/job/repo/12/')
    expect(details.jobs[0].url).toBe('https://ci.example.com/job/team/job/repo/12/')
  })

  it('prefers wfapi timings over the build payload', () => {
    const details = jenkinsBuildToCheckRunDetails({
      check,
      location,
      build: { number: 12, building: false, result: 'SUCCESS', timestamp: 1_000, duration: 5 },
      stages: { startTimeMillis: 2_000, durationMillis: 60_000, stages: [] }
    })

    expect(details.startedAt).toBe('1970-01-01T00:00:02.000Z')
    expect(details.completedAt).toBe('1970-01-01T00:01:02.000Z')
  })

  it('bounds the parameters and commits it reports', () => {
    const details = jenkinsBuildToCheckRunDetails({
      check,
      location,
      build: {
        number: 1,
        building: false,
        result: 'SUCCESS',
        actions: [
          {
            _class: 'hudson.model.ParametersAction',
            parameters: Array.from({ length: 40 }, (_, index) => ({
              _class: 'hudson.model.StringParameterValue',
              name: `P${index}`,
              value: String(index)
            }))
          }
        ],
        changeSets: [
          {
            items: Array.from({ length: 20 }, (_, index) => ({
              commitId: `sha${index}`,
              msg: `Commit ${index}`
            }))
          }
        ]
      },
      stages: null
    })

    expect(details.build?.parameters).toHaveLength(20)
    expect(details.build?.commits).toHaveLength(5)
  })

  it('survives payloads that are not what Jenkins promised', () => {
    const details = jenkinsBuildToCheckRunDetails({
      check,
      location,
      build: 'not json',
      stages: { stages: ['nonsense', { name: 'Real', status: 'SUCCESS' }, { status: 'SUCCESS' }] }
    })

    expect(details.jobs[0].name).toBe('team / repo / main')
    expect(details.jobs[0].steps.map((step) => step.name)).toEqual(['Real'])
    expect(details.title).toBeNull()
    expect(details.build).toEqual({
      number: null,
      queuedMs: null,
      estimatedDurationMs: null,
      triggeredBy: null,
      parameters: [],
      commits: []
    })
  })
})
