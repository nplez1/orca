import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

export const REPO_ROOT = new URL('../../', import.meta.url).pathname

/** The parsed workflow at `path`, with the YAML-1.1 reading of the `on:` key normalised away. */
export function readWorkflow(path) {
  const doc = parse(readFileSync(new URL(path, new URL('../../', import.meta.url)), 'utf8'))
  const on = Object.hasOwn(doc, 'on') ? doc.on : doc[true]
  return { ...doc, on, triggers: triggerKeys(on) }
}

export function triggerKeys(on) {
  if (on === null || on === undefined) {
    return []
  }
  if (typeof on === 'string') {
    return [on]
  }
  if (Array.isArray(on)) {
    return on.map(String)
  }
  return Object.keys(on)
}

/** `uses:` targets, excluding this repository's own composite actions and reusable workflows. */
export function externalUses(steps) {
  return steps.map((step) => step.uses).filter((uses) => uses && !uses.startsWith('./'))
}

/** Every `uses:` in the workflow, `needs` order flattened — jobs are the unit that runs steps. */
export function allUses(workflow) {
  return Object.values(workflow.jobs ?? {}).flatMap((job) => externalUses(job.steps ?? []))
}

export function jobNames(workflow) {
  return Object.keys(workflow.jobs ?? {})
}

/** The literal `needs` list of a job, whether it is written as a string or a list. */
export function needsOf(workflow, job) {
  const needs = workflow.jobs?.[job]?.needs
  if (!needs) {
    return []
  }
  return Array.isArray(needs) ? needs : [needs]
}

/** Every `run:` script in the workflow, joined, for asserting that a step does something. */
export function runScripts(workflow) {
  return Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run)
    .filter(Boolean)
}
