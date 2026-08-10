--- Tag-torture fixture: every moonwave tag on a path from extractor to
--- rendered page. See [Widget] and [Promise] for prose links.

local RunService = game:GetService("RunService")

local Widget = require("@self/Widget")
local extra = require("@self/extra")

--- @class Tagged
local Tagged = {}

Tagged.Widget = Widget

--- Creates a widget.
--- @param name string -- the display name
--- @return Widget -- the new widget
--- @tag constructor
function Tagged.create(name: string): Widget.Widget
	return Widget.new(name)
end

--- Blocks until the widget is saved.
--- @yields
--- @server
--- @plugin
--- @error string -- when the datastore is unavailable
function Tagged.save(widget: Widget.Widget): boolean
	return extra.persist(widget)
end

--- Waits for the registry to settle: the Yields badge is detected, not tagged.
function Tagged.flush()
	task.wait()
end

--- The realm badge comes from the tag, not the body: the fire is incidental.
--- @server
function Tagged.mirror(remote: any)
	remote:FireServer("mirror")
end

--- The prototype every draft copies. Nothing here declares its type: it comes
--- from what `Widget.new` returns, resolved in Widget.luau's own scope.
Tagged.blank = Widget.new("")

--- Where saved widgets land, mounted only where the guard passes: the Server
--- badge and the optional type both come off that one expression, untagged.
Tagged.storage = RunService:IsServer() and script:WaitForChild("Storage")

--- Hard caps, frozen: the prop below renders Read Only without a tag.
Tagged.Limits = table.freeze({
	--- The registry stops accepting widgets past this.
	maxWidgets = 50,
})

--- The old spelling of [Tagged.Limits]. One table under two names: the first
--- became the section, so this one is typed as a link to it.
Tagged.Caps = Tagged.Limits

--- @class Draft
--- An in-progress widget kept off the registry (factory pattern: the class
--- never joins the module surface).
local Draft = {}

--- Discards the draft.
function Draft:discard() end

--- @deprecated v2 -- use [Tagged.create] instead
--- @since v0.9.0
function Tagged.make(name: string): Widget.Widget
	return Widget.new(name)
end

--- @private
function Tagged.internalReset() end

--- @ignore
function Tagged.debugDump() end

--- @unreleased
--- @deprecated
function Tagged.preview(): string
	return "soon"
end

--- Writes the widget to storage.
--- @function persist
--- @within Widget
--- @tag storage

return Tagged
