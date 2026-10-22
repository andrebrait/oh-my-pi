import type { InteractiveModeContext } from "../../modes/types";
import type { HostedClientLink } from "../../session-host/hosted-client";
import { errorMessage } from "./parse";

/**
 * Run a command on the session host this terminal is attached to. Its result reaches the view as host frames; a
 * refusal (`stale`, `session_busy`) is shown and never retried. `false`: nothing ran, so the caller keeps the input.
 */
export async function runOnHost(
	ctx: InteractiveModeContext,
	write: (link: HostedClientLink) => Promise<void>,
	done: string,
): Promise<boolean> {
	const link = ctx.hostedClient;
	if (!link) {
		ctx.showStatus("Not connected to the session host yet");
		return false;
	}
	try {
		await write(link);
	} catch (error) {
		ctx.showError(errorMessage(error));
		return false;
	}
	ctx.showStatus(done);
	return true;
}
