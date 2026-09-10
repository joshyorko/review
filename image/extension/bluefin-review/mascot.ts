/**
 * Bluefin Deinonychus Raptor Mascot Art & Animation
 * Based on Jacob Schnurr's Bluefin dinosaur artwork (Deinonychus antirrhopus, leader of the flock).
 */

import type { Painter } from "./glyphs.ts";

/**
 * 4-frame animated running Bluefin raptor for compact status strips and headers.
 * Sized ~14 chars wide by 2 chars high, perfect for terminal chrome.
 */
export const RAPTOR_FRAMES = [
	// Frame 0: Stride Forward (Pouncing)
	[
		" __,---.o>",
		"`--' /_> \\",
	],
	// Frame 1: Stride Mid (Tuck)
	[
		" __,---.o>",
		"`--'  |   |",
	],
	// Frame 2: Stride Back (Push)
	[
		" __,---.o>",
		"`--' / <_/",
	],
	// Frame 3: Leap (Airborne)
	[
		"  _,---.o>",
		"`--' //  \\\\",
	],
] as const;

/**
 * Full ASCII Mascot Banner of Bluefin (Deinonychus)
 * For the cockpit dashboard help and welcome screen.
 */
export const BLUEFIN_RAPTOR_BANNER = [
	"                __                                 ",
	"               / _)      .---.                     ",
	"      _.----._/ /       / /\"\\ \\,                   ",
	"     /         /        \\ \\_/  o>   BLUEFIN RAPTOR ",
	"  __/ (  | (  |          `.__.-'   Deinonychus     ",
	" /__.-'|_|--|_|             //     Leader of the   ",
	"                           \"\"      Flock           ",
] as const;

/**
 * Render a 1-line running Bluefin dino avatar.
 * frame cycles smoothly across the 4 animation states.
 */
export function renderRaptorGlyph(painter: Painter, frame: number): string {
	const step = ((Math.floor(frame / 2) % 4) + 4) % 4;
	const legFrames = ["/_> \\", " |   |", "/ <_/", "//  \\\\"];
	const head = painter.fg("accent", "__,---.o>");
	const legs = painter.fg("dim", legFrames[step]!);
	return `${head} ${legs}`;
}

/**
 * Render a compact 2-line ASCII mascot for banners or overlays.
 */
export function renderRaptorMini(painter: Painter, frame: number): string[] {
	const step = ((Math.floor(frame / 2) % 4) + 4) % 4;
	const f = RAPTOR_FRAMES[step]!;
	return [
		painter.fg("accent", f[0]!),
		painter.fg("text", f[1]!),
	];
}
