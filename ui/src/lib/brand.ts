/**
 * Per-tool brand colors for the os-eco ecosystem.
 *
 * Source of truth: ../../../../branding/visual-spec.md
 *
 * Use this module whenever a UI surface needs to label or highlight a specific
 * ecosystem tool (e.g. "this run came from greenhouse", "this expertise lives
 * in mulch"). Page-wide chrome should keep using semantic tokens (`--primary`,
 * `--accent`) rather than tool brands.
 */

export const TOOL_BRAND = {
	mulch: { rgb: [139, 90, 43] as const, label: "mulch" },
	seeds: { rgb: [124, 179, 66] as const, label: "seeds" },
	sapling: { rgb: [76, 175, 80] as const, label: "sapling" },
	canopy: { rgb: [56, 142, 60] as const, label: "canopy" },
	overstory: { rgb: [46, 125, 50] as const, label: "overstory" },
	greenhouse: { rgb: [124, 179, 66] as const, label: "greenhouse" },
} as const;

export type ToolKey = keyof typeof TOOL_BRAND;

export function toolHex(tool: ToolKey): string {
	const [r, g, b] = TOOL_BRAND[tool].rgb;
	const hex = (n: number) => n.toString(16).padStart(2, "0");
	return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export function toolRgb(tool: ToolKey): string {
	const [r, g, b] = TOOL_BRAND[tool].rgb;
	return `rgb(${r}, ${g}, ${b})`;
}

export function toolRgba(tool: ToolKey, alpha: number): string {
	const [r, g, b] = TOOL_BRAND[tool].rgb;
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
