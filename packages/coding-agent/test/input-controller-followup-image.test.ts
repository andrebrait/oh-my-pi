/**
 * Regression: queuing a follow-up message (Ctrl+Enter / `app.message.followUp`)
 * with a pending clipboard-pasted image must forward the image to
 * `session.prompt`. Previously `handleFollowUp` ignored `pendingImages`, so the
 * queued message reached the model as text only and the image was silently
 * dropped.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { InputEventResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

interface StubEditor {
	onSubmit?: (text: string) => Promise<void>;
	setText: (text: string) => void;
	getText: () => string;
	getExpandedText: () => string;
	setCollapsedText: (text: string) => void;
	composerChips: () => unknown[];
	addToHistory: (text: string) => void;
	imageLinks?: unknown;
	pendingImages: ImageContent[];
	pendingImageLinks: (string | undefined)[];
	clearDraft: (text?: string) => void;
}
interface PromptOptionsLike {
	streamingBehavior?: "steer" | "followUp";
	images?: ImageContent[];
}

function createContext(opts: {
	isStreaming: boolean;
	pendingImages: ImageContent[];
	pendingImageLinks?: (string | undefined)[];
	input?: (text: string, images: ImageContent[] | undefined, source: string) => Promise<InputEventResult>;
}) {
	let editorText = "";
	const editor: StubEditor = {
		setText(text) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		getExpandedText() {
			return editorText;
		},
		setCollapsedText(text) {
			editorText = text;
		},
		composerChips() {
			return [];
		},
		addToHistory: vi.fn(),
		pendingImages: opts.pendingImages,
		pendingImageLinks: opts.pendingImageLinks ? [...opts.pendingImageLinks] : opts.pendingImages.map(() => undefined),
		clearDraft(text?: string) {
			if (text !== undefined) this.addToHistory(text);
			this.setText("");
			this.imageLinks = undefined;
			this.pendingImages = [];
			this.pendingImageLinks = [];
		},
	};
	const prompt = vi.fn(async (_text: string, _options?: PromptOptionsLike) => {});
	const updatePendingMessagesDisplay = vi.fn();
	const requestRender = vi.fn();
	const showError = vi.fn();
	const emitInput = vi.fn(opts.input ?? (async () => ({})));
	const queueCompactionMessage = vi.fn();

	const handleGoalModeCommand = vi.fn(async (_prompt?: string, _input?: unknown) => true);
	const handlePlanModeCommand = vi.fn(async (_prompt?: string, _input?: unknown) => true);
	const handleVibeModeCommand = vi.fn(async (_prompt?: string, _input?: unknown) => true);
	const ctx = {
		editor,
		ui: { requestRender },
		skillCommands: new Map<string, string>(),
		fileSlashCommands: new Set<string>(),
		isKnownSlashCommand: () => false,
		sessionManager: { putBlob: async () => ({ displayPath: "blob://transformed.png" }) },
		queueCompactionMessage,
		session: {
			isStreaming: opts.isStreaming,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			extensionRunner: opts.input ? { hasHandlers: () => true, emitInput, getCommand: () => undefined } : undefined,
			prompt,
			customCommands: [],
			promptTemplates: [],
		},
		loopModeEnabled: false,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		updatePendingMessagesDisplay,
		showError,
		planModeEnabled: false,
		planModePaused: false,
		vibeModeEnabled: false,
		goalModeEnabled: false,
		goalModePaused: false,
		handleGoalModeCommand,
		handlePlanModeCommand,
		handleVibeModeCommand,
		withLocalSubmission: async (_text: string, fn: () => unknown) => fn(),
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		editor,
		handleGoalModeCommand,
		handlePlanModeCommand,
		handleVibeModeCommand,
		prompt,
		showError,
		emitInput,
		queueCompactionMessage,
	};
}

describe("InputController.handleFollowUp image forwarding", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards pending images to session.prompt while streaming and clears them", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
		const { ctx, editor, prompt } = createContext({ isStreaming: true, pendingImages: [image] });

		const controller = new InputController(ctx);
		editor.setText("[Image #1] look at this");
		await controller.handleFollowUp();

		expect(prompt).toHaveBeenCalledTimes(1);
		const call = prompt.mock.calls[0];
		if (!call) throw new Error("expected session.prompt to be called");
		expect(call[0]).toBe("[Image #1] look at this");
		expect(call[1]?.streamingBehavior).toBe("followUp");
		expect(call[1]?.images).toEqual([image]);

		// Pending image state is consumed so the next message does not resend it.
		expect(ctx.editor.pendingImages).toEqual([]);
		expect(ctx.editor.pendingImageLinks).toEqual([]);
	});

	it("queues image-only follow-ups while streaming", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
		const { ctx, editor, prompt } = createContext({ isStreaming: true, pendingImages: [image] });

		const controller = new InputController(ctx);
		editor.setText("[Image #1]");
		await controller.handleFollowUp();

		expect(prompt).toHaveBeenCalledTimes(1);
		const call = prompt.mock.calls[0];
		if (!call) throw new Error("expected session.prompt to be called");
		expect(call[0]).toBe("[Image #1]");
		expect(call[1]?.streamingBehavior).toBe("followUp");
		expect(call[1]?.images).toEqual([image]);
		expect(ctx.editor.pendingImages).toEqual([]);
	});

	it("forwards pending images when not streaming", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "d29ybGQ=" };
		const { ctx, editor, prompt } = createContext({ isStreaming: false, pendingImages: [image] });

		const controller = new InputController(ctx);
		editor.setText("[Image #1] describe it");
		await controller.handleFollowUp();

		expect(prompt).toHaveBeenCalledTimes(1);
		const call = prompt.mock.calls[0];
		if (!call) throw new Error("expected session.prompt to be called");
		expect(call[1]?.images).toEqual([image]);
		expect(call[1]?.streamingBehavior).toBeUndefined();
		expect(ctx.editor.pendingImages).toEqual([]);
	});

	it("omits images when none are pending", async () => {
		const { ctx, editor, prompt } = createContext({ isStreaming: true, pendingImages: [] });

		const controller = new InputController(ctx);
		editor.setText("just text");
		await controller.handleFollowUp();

		expect(prompt).toHaveBeenCalledTimes(1);
		const call = prompt.mock.calls[0];
		if (!call) throw new Error("expected session.prompt to be called");
		expect(call[1]?.images).toBeUndefined();
		expect(call[1]?.streamingBehavior).toBe("followUp");
	});

	it("restores text and pending images when streaming follow-up dispatch rejects", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
		const { ctx, editor, prompt, showError } = createContext({
			isStreaming: true,
			pendingImages: [image],
			pendingImageLinks: ["local://draft.png"],
		});
		prompt.mockImplementationOnce(async () => {
			throw new Error("queue rejected");
		});

		const controller = new InputController(ctx);
		editor.setText("[Image #1] look at this");
		await controller.handleFollowUp();

		expect(showError).toHaveBeenCalledWith("queue rejected");
		expect(editor.getText()).toBe("[Image #1] look at this");
		expect(ctx.editor.pendingImages).toEqual([image]);
		expect(ctx.editor.pendingImageLinks).toEqual(["local://draft.png"]);
		expect(ctx.editor.imageLinks).toEqual(["local://draft.png"]);
	});

	it("restores image-only follow-ups when idle dispatch rejects", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
		const { ctx, editor, prompt, showError } = createContext({
			isStreaming: false,
			pendingImages: [image],
		});
		prompt.mockImplementationOnce(async () => {
			throw new Error("model not configured");
		});

		const controller = new InputController(ctx);
		editor.setText("[Image #1]");
		await controller.handleFollowUp();

		expect(showError).toHaveBeenCalledWith("model not configured");
		expect(editor.getText()).toBe("[Image #1]");
		expect(ctx.editor.pendingImages).toEqual([image]);
		expect(ctx.editor.pendingImageLinks).toEqual([undefined]);
		expect(ctx.editor.imageLinks).toEqual([undefined]);
	});

	it("forwards follow-up mode attachments before the command clears the draft", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
		const { ctx, editor, handleGoalModeCommand } = createContext({
			isStreaming: false,
			pendingImages: [image],
			pendingImageLinks: ["local://draft.png"],
		});

		const controller = new InputController(ctx);
		editor.setText("/goal set Ship the release [Image #1]");
		await controller.handleFollowUp();

		expect(handleGoalModeCommand).toHaveBeenCalledWith("set Ship the release [Image #1]", {
			images: [image],
			imageLinks: ["local://draft.png"],
		});
		expect(ctx.editor.pendingImages).toEqual([]);
		expect(ctx.editor.pendingImageLinks).toEqual([]);
	});

	for (const key of ["Enter", "Ctrl+Enter"] as const) {
		const submit = async (controller: InputController, editor: StubEditor) => {
			if (key === "Ctrl+Enter") await controller.handleFollowUp();
			else {
				controller.setupEditorSubmitHandler();
				await editor.onSubmit?.(editor.getText());
			}
		};

		it(`${key} transforms text and images once before interpreting a builtin command`, async () => {
			const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
			const { ctx, editor, emitInput, prompt, handleGoalModeCommand } = createContext({
				isStreaming: true,
				pendingImages: [],
				input: async text => ({ text: `/goal set ${text} [Image #1]`, images: [image] }),
			});
			editor.setText("normal mode");
			await submit(new InputController(ctx), editor);

			expect(emitInput).toHaveBeenCalledTimes(1);
			expect(emitInput).toHaveBeenCalledWith("normal mode", undefined, "interactive");
			expect(handleGoalModeCommand).toHaveBeenCalledWith("set normal mode [Image #1]", {
				images: [image],
				imageLinks: ["blob://transformed.png"],
			});
			expect(prompt).not.toHaveBeenCalled();
		});

		it(`${key} consumes handled input before slash dispatch or compaction queueing`, async () => {
			const { ctx, editor, emitInput, prompt, handleGoalModeCommand, queueCompactionMessage } = createContext({
				isStreaming: true,
				pendingImages: [],
				input: async () => ({ handled: true }),
			});
			Object.assign(ctx.session, { isCompacting: true });
			editor.setText("/goal set stop ponytail");
			await submit(new InputController(ctx), editor);

			expect(emitInput).toHaveBeenCalledTimes(1);
			expect(handleGoalModeCommand).not.toHaveBeenCalled();
			expect(queueCompactionMessage).not.toHaveBeenCalled();
			expect(prompt).not.toHaveBeenCalled();
			expect(editor.getText()).toBe("");
		});

		it(`${key} queues transformed input rather than the original draft during compaction`, async () => {
			const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
			const { ctx, editor, emitInput, queueCompactionMessage } = createContext({
				isStreaming: true,
				pendingImages: [],
				input: async text => ({ text: `transformed ${text}`, images: [image] }),
			});
			Object.assign(ctx.session, { isCompacting: true });
			editor.setText("stop ponytail");
			await submit(new InputController(ctx), editor);

			expect(emitInput).toHaveBeenCalledTimes(1);
			expect(queueCompactionMessage).toHaveBeenCalledWith(
				"transformed stop ponytail",
				key === "Enter" ? "steer" : "followUp",
				[image],
			);
		});
	}

	it("restores transformed follow-up text and image links after dispatch rejects", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
		const { ctx, editor, prompt, emitInput } = createContext({
			isStreaming: true,
			pendingImages: [],
			input: async () => ({ text: "transformed [Image #1]", images: [image] }),
		});
		prompt.mockRejectedValueOnce(new Error("queue rejected"));
		editor.setText("stop ponytail");
		await new InputController(ctx).handleFollowUp();

		expect(emitInput).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("transformed [Image #1]");
		expect(editor.pendingImages).toEqual([image]);
		expect(editor.pendingImageLinks).toEqual(["blob://transformed.png"]);
	});

	it("observes a typed continue shortcut once without emitting its synthetic directive as input", async () => {
		const { ctx, editor, emitInput } = createContext({
			isStreaming: false,
			pendingImages: [],
			input: async () => ({}),
		});
		const onInput = vi.fn();
		ctx.onInputCallback = onInput;
		editor.setText(".");
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		await editor.onSubmit?.(".");

		expect(emitInput).toHaveBeenCalledTimes(1);
		expect(emitInput).toHaveBeenCalledWith(".", undefined, "interactive");
		expect(onInput).toHaveBeenCalledWith(expect.objectContaining({ synthetic: true, userInitiated: true }));
	});
});
