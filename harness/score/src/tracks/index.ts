import type { Scenario } from "../scenario.ts";
import { aiPeerScenarios } from "./ai-peer.ts";
import { filesScenarios } from "./files.ts";
import { hostileScenarios } from "./hostile.ts";
import { runtimeScenarios } from "./runtime.ts";
import { syncCoreScenarios } from "./sync-core.ts";

export const trackScenarios: Scenario[] = [...syncCoreScenarios, ...filesScenarios, ...hostileScenarios, ...aiPeerScenarios, ...runtimeScenarios];
