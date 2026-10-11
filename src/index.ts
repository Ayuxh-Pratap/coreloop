/**
 * coreloop-engine: the public API. A local, surface-neutral voice engine: what someone says → code first → a
 * small local model only picks among options code wrote → code checks the pick → one safe action, planned and run
 * by a surface.
 *
 * What a host does:
 *
 *   import { Actor, FallbackDecider, SystemOneClient, useProfile } from "coreloop-engine";
 *   const actor = new Actor({ client: new FallbackDecider(new SystemOneClient({ baseUrl, timeoutMs: 3000 })), surface });
 *   const result = await actor.handle("open the settings page");
 *
 * What a surface does: implement `Surface` (view, plan, run) and declare its skills as data. In another process, the
 * same contract travels over a loopback WebSocket (`serveSurface`). `conformance()` checks a surface.
 *
 * Everything here runs in Node and in a browser: no Node modules, no dependencies (test/boundary.test.ts).
 */

// the loop
export { Actor, type ActorOptions, type ActResult } from "./live/actor.ts";
export { understand, understandByCode, type Understood, type UnderstandOptions } from "./core/pipeline.ts";
export { Session, whatICanDo, THRESHOLDS, type Choice, type Outcome } from "./core/policy.ts";
export { normalise, type Normalised } from "./core/normalise.ts";

// the model: anything that answers a request
export {
  SystemOneClient,
  SystemOneError,
  type Answer,
  type ChoiceAnswer,
  type Decider,
  type Decision,
  type SystemOneRequest,
} from "./backends/systemone.ts";
export { CodeOnlyDecider, FallbackDecider, CODE_ONLY } from "./backends/codeonly.ts";
export { buildRequest, type RequestOptions } from "./core/questions.ts";

// the surface contract (v2), several surfaces, and the wire
export { PlanError, type Assume, type Decided, type Place, type Plan, type Receipt, type Surface, type SurfaceView } from "./surface/contract.ts";
export { Surfaces, chain } from "./surface/router.ts";
export {
  PROTOCOL_VERSION,
  MAX_MESSAGE_BYTES,
  ProtocolError,
  parseHello,
  parseMessage,
  parsePlan,
  parseReceipt,
  parseView,
  type Call,
  type Hello,
  type Method,
  type Result,
  type Welcome,
} from "./surface/protocol.ts";
export { serveSurface, type ServeOptions, type SurfaceConnection } from "./surface/client.ts";
export { conformance, defaultSamples, type Check, type ConformanceOptions } from "./surface/conformance.ts";

// skills as data
export { SkillSet, commonOnly } from "./skills/skillset.ts";
export { parseSkills, SkillError } from "./skills/validate.ts";
export { SLOT_KINDS, type SlotKind } from "./skills/slotkinds.ts";
export type { CheckCtx, Skill, SkillAction, TemplateSpec } from "./skills/types.ts";
export { COMMON_OPERATIONS, ALL_COMMON, CONVERSATION, type Operation, type Risk } from "./core/operations.ts";
export { isPassword, MAX_OPTIONS, type Item } from "./core/items.ts";
export type { AppEntry } from "./core/apps.ts";
export type { Slots, SlotContext, Target } from "./core/slots.ts";

// a person's profile
export { useProfile, currentProfile, checkProfile, EMPTY_PROFILE, ProfileError, type Phrase, type Profile } from "./profile/profile.ts";

// what the engine did, step by step (off unless asked for)
export { traced, tracing, type TraceStep } from "./core/trace.ts";
