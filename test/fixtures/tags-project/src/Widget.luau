--- @class Widget
--- @__index Widget
--- @tag ui
--- A stateful widget.
---
--- :::caution
--- The rendering pipeline is experimental.
--- :::
---
--- <Tabs>
--- <TabItem value="named" label="Named">
---
--- ```luau
--- local widget = Widget.new("panel")
--- ```
---
--- </TabItem>
--- <TabItem value="blank">
---
--- ```luau
--- local widget = Widget.new("")
--- ```
---
--- </TabItem>
--- </Tabs>
---
--- @external Promise https://eryn.io/roblox-lua-promise/lib/
local Widget = {}
Widget.__index = Widget

export type Widget = typeof(setmetatable({} :: { name: string }, Widget))

--- @interface WidgetOptions
--- .name string -- display name
--- .scale number? -- render scale

--- @class Widget.Skin
--- Visual skin applied to a widget (the dotted name stays whole).

--- @prop border number
--- @within Widget.Skin
--- Border width in pixels.

--- @readonly
--- The semantic version of the widget system.
Widget.version = "1.0.0"

--- Empty here, typed by the floating `@prop` in extra.luau: an author naming
--- the shape outranks the `{}` the value would infer on its own.
Widget.slots = {}

--- Makes a widget.
--- @param name string -- the display name
function Widget.new(name: string): Widget
	return setmetatable({ name = name }, Widget)
end

--- Loads a widget asynchronously.
--- @return Promise -- resolves with the loaded [Widget]
function Widget.load(name: string): Promise
	return name :: any
end

--- Renames the widget.
--- @client
function Widget:rename(name: string)
	self.name = name
end

--- Fires the widget's activation: the Client badge is detected, not tagged.
function Widget:activate()
	self._remote:FireServer(self.name)
end

--- Applies a skin: the parameter docs are trailing comments, except where a
--- tag outranks one.
--- @param skin -- the tag wins over the trailing comment
function Widget:reskin(
	skin: string, -- the skin's registered name
	scale: number -- multiplier against the base size
): boolean
	return skin ~= "" and scale > 0
end

--- @ignore
export type Internal = { secret: boolean }

--- Captures internal state.
function Widget:capture(): Internal
	return { secret = true } :: any
end

--- @within Tagged
--- How name collisions resolve during creation.
export type CreatePolicy = "error" | "rename"

--- @ignore
type WidgetBase = never

type WidgetBase = { id: number }

--- Options controlling a rename.
--- @field validate boolean -- reject empty names
export type RenameOptions = {
	--- Fired when the rename lands.
	changed: (Widget) -> (),
	silent: boolean, -- skip events
	validate: boolean,
}

--- A widget snapshot: base identity plus capture state.
--- @field frozen boolean -- no further updates
--- @field at number -- capture timestamp
export type Snapshot = WidgetBase & {
	frozen: boolean,
	at: number,
}

local manifest = {
	widget = nil :: Widget?,
	locked = false,
}

--- @interface Manifest
--- .widget Widget? -- the active widget
---
--- .locked boolean
export type Manifest = typeof(manifest)

--- Widens a widget type to its base shape.
export type function Widen(ty: type)
	return ty
end

--- The widget's lifecycle phase.
export type Phase =
	"idle"
	| "active"
	| "retired"

return Widget
