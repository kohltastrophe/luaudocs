local Impl = {}

--- Greets a caller by name.
function Impl.greet(name: string): string
	return "Hello, " .. name
end

return Impl
