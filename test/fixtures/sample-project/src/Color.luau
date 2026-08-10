local Linear = {}

--- Converts a gamma-encoded channel to linear
function Linear.fromGamma(channel: number): number
	return channel ^ 2.2
end

--- Converts a linear channel back to gamma-encoded
function Linear.toGamma(channel: number): number
	return channel ^ (1 / 2.2)
end

local Polar = {}

--- Converts cartesian coordinates to an angle
function Polar.fromCartesian(x: number, y: number): number
	return math.atan2(y, x)
end

--- Converts an angle back to cartesian coordinates
function Polar.toCartesian(angle: number): (number, number)
	return math.cos(angle), math.sin(angle)
end

--- Two nested tables, so each becomes its own section on the page.
local Color = {
	Linear = Linear,
	Polar = Polar,
}

return Color
