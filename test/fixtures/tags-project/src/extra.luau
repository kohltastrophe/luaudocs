--- Helpers documenting members onto [Widget] from another file (moonwave
--- manual mode: floating placing tags + cross-module @within relocation),
--- written as blocks like:
---
--- ```
--- @function describe
--- @within Widget
--- ```

--- @prop theme string
--- @within Widget
--- Active theme name.

--- @prop owner Tagged
--- @within Widget
--- Owning registry; this file binds no `Tagged`, so the ref stays plain.

--- @prop slots { string }
--- @within Widget
--- Named render slots; Widget.luau spells the value, this spells the type.

--- @function describe
--- @within Widget
--- @param widget Widget -- the widget to describe
--- @return string - a human-readable description

--- @method Widget:refresh
--- @param force boolean -- re-render even when clean
--- Redraws the widget.

--- @type ThemeName string -- a theme identifier
--- @within Widget

local extra = {}

--- @within Widget
function extra.persist(widget: any): boolean
	return widget ~= nil
end

return extra
