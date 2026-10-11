/**
 * The decision model a host runs with: decider-0.8b over HTTP while it answers, code only while it doesn't, so
 * the core starts and keeps working without the model server. `--no-model` asks for code only from the start.
 */
import { CodeOnlyDecider, FallbackDecider } from "../backends/codeonly.ts";
import { SystemOneClient, type Decider } from "../backends/systemone.ts";
import { config } from "../config.ts";

export async function startDecider(opts: { noModel?: boolean; say?: (line: string) => void } = {}): Promise<Decider> {
  const say = opts.say ?? ((line: string) => console.error(line));
  if (opts.noModel) {
    say("no-model mode: code decides what it can and asks about the rest");
    return new CodeOnlyDecider();
  }
  const http = new SystemOneClient({ baseUrl: config.decider.url, timeoutMs: config.decider.timeoutMs });
  if (!(await http.health()).ok) {
    say(`model server not reachable at ${config.decider.url}: running without it (code decides what it can, asks about the rest). Start it: npm run models:start`);
  }
  return new FallbackDecider(http, {
    onChange: (usingModel, why) => say(usingModel ? "the model is answering again" : `the model stopped answering (${why}): running without it until it's back`),
  });
}
