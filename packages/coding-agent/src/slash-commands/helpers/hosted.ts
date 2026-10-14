import type { InteractiveModeContext } from "../../modes/types";
import type { HostedClientLink } from "../../session-host/hosted-client";
import { errorMessage } from "./parse";

/**
 * Run a command on the session host this terminal is attached to. Its result reaches the view as host frames; a
 * refusal (`stale`, `session_busy`) is shown and never retried.
 */
export async function runOnHost(
	ctx: InteractiveModeContext,
	write: (link: HostedClientLink) => Promise<void>,
	done: string,
): Promise<void> {
	const link = ctx.hostedClient;
	if (!link) {
		ctx.showStatus("Not connected to the session host yet");
		return;
	}
	try {
		await write(link);
		ctx.showStatus(done);
	} catch (error) {
		ctx.showError(errorMessage(error));
	}
}
