/**
 * Clean, Minimalist ASCII Splash Screen for Project Bluefin in Oh My Pi (omp).
 * Features the Bluefin Deinonychus with its dialog bubble, telemetry, and sync progress.
 */

import { truncateToWidth, visibleWidth } from "./width.ts";

export interface SplashHostTui {
	requestRender(): void;
}

/** ~8 FPS: smooth, clean animation. */
const FRAME_MS = 125;
/**
 * Two full animation cycles, then the splash leaves on its own.
 *
 * An intro that only a keypress can dismiss is an intro that hides the queue
 * from anyone who walked away during startup, and blocks whatever the session
 * meant to open next.
 */
const FRAMES = 32;

export class BluefinAnsiSplash {
	private tui: SplashHostTui;
	private done: () => void;
	private frame = 0;
	private interval: NodeJS.Timeout | null = null;
	private finished = false;

	constructor(tui: SplashHostTui, done: () => void) {
		this.tui = tui;
		this.done = done;
		this.start();
	}

	private start(): void {
		this.interval = setInterval(() => {
			this.frame++;
			if (this.frame >= FRAMES) {
				this.finish();
				return;
			}
			this.tui.requestRender();
		}, FRAME_MS);
	}

	/** Idempotent: the host may dispose a component the timer already finished. */
	private finish(): void {
		if (this.finished) return;
		this.finished = true;
		this.dispose();
		this.done();
	}

	dispose(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	handleInput(_data: string): void {
		// Any keypress dismisses the splash intro early.
		this.finish();
	}

	render(width: number): string[] {
		const f = this.frame;
		const innerW = 60;

		const RST = "\x1b[0m";
		const ACC = "\x1b[1;36m"; // Bright Cyan
		const TXT = "\x1b[1;37m"; // Bright White
		const DIM = "\x1b[2;37m"; // Muted Gray
		const BRD = "\x1b[38;5;240m"; // Border Gray

		// Subtle blink
		const blink = f % 16 >= 14;
		const eye = blink ? "-" : "o";

		// Smooth cycling progress bar
		const progress = (f % 16) + 1;
		const busFill = "▓".repeat(progress) + "░".repeat(16 - progress);

		const padRow = (content: string) => {
			const len = visibleWidth(content);
			const space = Math.max(0, innerW - len);
			return `${BRD}│${RST} ${content}${" ".repeat(space)} ${BRD}│${RST}`;
		};

		// Standalone speech bubble: cleanly bounded box with stem pointing to dino
		const bIndent = " ".repeat(19);
		const bTop = `${bIndent}${BRD}╭───────────────────────────────────╮${RST}`;
		const bM1  = `${bIndent}${BRD}│${RST} ${TXT}You eat 4x more food than I do.${RST}   ${BRD}│${RST}`;
		const bM2  = `${bIndent}${BRD}│${RST} ${ACC}Efficient AF.${RST}                     ${BRD}│${RST}`;
		const bBot = `${bIndent}${BRD}╰───╮───────────────────────────────╯${RST}`;
		const tail = `${" ".repeat(17)}${ACC}__${RST}     ${BRD}/${RST}`;
		const head = `${" ".repeat(16)}${ACC}/ ${eye} \\${RST}`;

		const dinoRows: string[] = [
			bTop,
			bM1,
			bM2,
			bBot,
			tail,
			head,
			`${" ".repeat(8)}${ACC}_.----._/ /${RST}`,
			`${" ".repeat(7)}${ACC}/         /${RST}`,
			`${" ".repeat(5)}${ACC}__/ (  | (  |${RST}`,
			`${" ".repeat(4)}${ACC}/__.-'|_|--|_|${RST}`,
		];

		const rows: string[] = [
			`${BRD}╭${"─".repeat(innerW + 2)}╮${RST}`,
			padRow(`${TXT}PROJECT BLUEFIN${RST} ${DIM}·${RST} ${ACC}REVIEW COCKPIT${RST}`),
			`${BRD}├${"─".repeat(innerW + 2)}┤${RST}`,
			padRow(""),
		];

		for (const line of dinoRows) {
			rows.push(padRow(line));
		}

		rows.push(padRow(""));
		rows.push(padRow(`  ${DIM}SYNC:${RST} ${ACC}${busFill}${RST}  ${DIM}CONNECTING TO HIVE...${RST}`));
		rows.push(padRow(""));
		rows.push(padRow(`  ${DIM}Press any key to enter...${RST}`));
		rows.push(`${BRD}╰${"─".repeat(innerW + 2)}╯${RST}`);
		rows.push(padRow("", 0));
		rows.push(padRow(`  ${DIM}SYNC:${RST} ${ACC}${busFill}${RST}  ${DIM}CONNECTING TO HIVE...${RST}`, 44));
		rows.push(padRow("", 0));
		rows.push(padRow(`  ${DIM}Press any key to enter...${RST}`, 27));
		rows.push(`${BRD}╰${"─".repeat(innerW + 2)}╯${RST}`);

		return rows.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {}
}
