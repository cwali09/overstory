import { type ToolKey, toolRgb, toolRgba } from "@/lib/brand";
import { cn } from "@/lib/utils";

/**
 * Stacked-bars ecosystem mark — six rounded bars top-to-bottom in canopy order:
 * greenhouse, overstory, canopy, sapling, seeds, mulch.
 *
 * Mirrors `branding/generate-logo.py` (which renders the PNG marketing asset).
 *
 * Props:
 *   size         — "sm" (default, 24px) or "md" (32px)
 *   showWordmark — when true, render the "overstory" wordmark to the right
 *   tool         — when set, only that tool's bar stays fully saturated; the
 *                  rest dim to ~30% opacity. Useful for the operator topbar
 *                  to emphasise overstory's place in the stack.
 */

const ORDER: ToolKey[] = ["greenhouse", "overstory", "canopy", "sapling", "seeds", "mulch"];

interface LogoProps {
	size?: "sm" | "md";
	showWordmark?: boolean;
	tool?: ToolKey;
	className?: string;
}

export function Logo({ size = "sm", showWordmark = false, tool, className }: LogoProps) {
	const px = size === "sm" ? 24 : 32;
	const barCount = ORDER.length;
	const gap = size === "sm" ? 1 : 1.5;
	const radius = size === "sm" ? 0.6 : 0.8;
	const barH = (px - gap * (barCount - 1)) / barCount;
	const barW = px * 1.6;
	const totalW = barW;

	const label = tool ? `${tool} mark` : "os-eco logo";
	return (
		<span className={cn("inline-flex items-center gap-2 select-none", className)}>
			<svg
				width={totalW}
				height={px}
				viewBox={`0 0 ${totalW} ${px}`}
				role="img"
				aria-label={label}
				xmlns="http://www.w3.org/2000/svg"
			>
				{ORDER.map((key, i) => {
					const y = i * (barH + gap);
					const dimmed = tool && tool !== key;
					const fill = dimmed ? toolRgba(key, 0.3) : toolRgb(key);
					return (
						<rect
							key={key}
							x={0}
							y={y}
							width={totalW}
							height={barH}
							rx={radius}
							ry={radius}
							fill={fill}
						/>
					);
				})}
			</svg>
			{showWordmark ? (
				<span className="font-semibold text-sm tracking-tight text-foreground">overstory</span>
			) : null}
		</span>
	);
}
