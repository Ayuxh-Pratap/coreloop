import { FIXTURE_PROFILE, useProfileFiles } from "../src/host/profile-files.ts";

// The engine reads no files; tests hand it the evals' fixture profile (eval/profile/), the same on every machine.
useProfileFiles(FIXTURE_PROFILE);
