// Stepped time of a clock summed from frame deltas.

/**
 * Whole steps of `fps` a second in `clock` seconds. Summed deltas land on either side of a step
 * (90 deltas of 1/60 s add up to 1.4999999999999996), so a clock within a millionth of a step
 * counts it: the frame at 1.5 s is the same however the deltas rounded.
 */
export const steps = (clock: number, fps: number): number => Math.floor(clock * fps + 1e-6)
