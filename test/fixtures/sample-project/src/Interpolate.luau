--- Blends two values, falling back to a hard switch at the midpoint. The module
--- *is* this function, so its page has no members.
local function Interpolate(a: any, b: any, t: number): any
	if type(a) == "number" and type(b) == "number" then
		return a + (b - a) * t
	end
	return if t < 0.5 then a else b
end

return Interpolate
