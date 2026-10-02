/**
 * List running session hosts (`omp --mode host`) from the local registry.
 */
import { sanitizeDisplayLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { attachHelp as commandHelp } from "../cli/command-help";
import { listSessionHosts } from "../session-host/registry";

export default class Attach extends Command {
	static description = commandHelp.description;

	static flags = {
		json: Flags.boolean({ description: "Print hosts as JSON" }),
	};

	static examples = ["omp attach", "omp attach --json"];

	async run(): Promise<void> {
		const { argv, flags } = await this.parse(Attach);
		// The parser passes positionals through; attach targets arrive in a later phase.
		if (argv.length > 0) throw new CliUsageError("attach accepts no arguments yet (usage: attach [--json])");
		// The registry token is a bearer credential: never print it.
		const hosts = (await listSessionHosts()).map(({ token: _token, ...rest }) => rest);
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(hosts)}\n`);
			return;
		}
		if (hosts.length === 0) {
			process.stdout.write("No session hosts running.\n");
			return;
		}
		for (const h of hosts) {
			// title, sessionFile, and cwd come from an entry another process wrote: strip control sequences and newlines.
			const label = sanitizeDisplayLine(h.title ?? h.sessionFile ?? "(new session)");
			const cwd = sanitizeDisplayLine(h.cwd);
			process.stdout.write(`${h.hostId}  ${h.clients}  ${h.busy ? "busy" : "idle"}  ${cwd}  ${label}\n`);
		}
	}
}
