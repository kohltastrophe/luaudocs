--- The model, four ways: the shared helpers directly, the finalize policies
--- with hand-built input (a failure names the policy), the assembled output
--- over the tags-project fixture (the 24-tag oracle; the docmodel capture
--- pins it byte-for-byte in CI, these assertions say what changed), and the
--- alias fixture pinning the passthrough shape neither capture reaches.
local t = require("./harness")
local paths = require("./paths")
local util = require("../util")
local tags = require("../tags")
local segs = require("../segs")
local model = require("../model")
local emitMod = require("../emit")
local members = require("../model/members")
local finalize = require("../model/finalize")

local byName = t.byName
local byId = t.byId

--- A fresh diagnostics sink + model context.
local function fresh(): (any, any)
	local diag = util.diagnostics()
	return diag, members.newCtx(diag)
end

--- Segments as the wire spells them: emit strips `__` keys, so in-memory ref
--- segments still carry their resolution scratch. Assertions about the wire
--- shape go through this projection.
local function wireSegs(list: { any }?): any
	if list == nil then
		return nil
	end
	local out = {}
	for _, seg in list do
		if type(seg) == "string" then
			table.insert(out, seg)
		else
			table.insert(out, if seg.id ~= nil then { text = seg.text, id = seg.id } else { text = seg.text })
		end
	end
	return out
end

local function wireLines(lines: { any }?): any
	if lines == nil then
		return nil
	end
	local out = {}
	for _, line in lines do
		table.insert(out, wireSegs(line))
	end
	return out
end

--- An empty graph: the finalize phases that need one (reexports, ref
--- resolution) degrade to no-ops against it, which is exactly what the
--- policy cases want.
local EMPTY_GRAPH: any = { modules = {}, byId = {}, byAbs = {} }

--- A module entry shaped like build.run makes one, holding `container`.
local function entryWith(id: string, name: string): any
	return {
		id = id,
		name = name,
		instancePath = { name },
		classes = {},
		members = {},
		types = {},
		reexports = {},
		source = { file = id, line = 1 },
	}
end

return function()
	t.suite("model: shared helpers")

	t.eq(members.mergeDescs(nil, nil), nil, "mergeDescs nil+nil")
	t.eq(members.mergeDescs("a", nil), "a", "mergeDescs keeps primary")
	t.eq(members.mergeDescs(nil, "b"), "b", "mergeDescs falls back to secondary")
	t.eq(members.mergeDescs("a", "a"), "a", "mergeDescs drops duplicate secondary")
	t.eq(members.mergeDescs("a", "b"), "a\n\nb", "mergeDescs joins with blank line")
	t.eq(members.mergeDescs("", "b"), "b", "mergeDescs treats empty primary as absent")

	t.eq(members.memberId("src/a.luau", "fn", nil, "run"), "src/a.luau#fn.run", "memberId bare name")
	t.eq(members.memberId("src/a.luau", "prop", "Widget", "size"), "src/a.luau#prop.Widget.size", "memberId qualified")
	t.eq(members.memberId("src/a.luau", "prop", "", "size"), "src/a.luau#prop.size", "memberId empty container = bare")

	t.eq(members.callee("Fonts", ".", "12187368317"), 'Fonts["12187368317"]', "callee brackets a non-identifier name")
	t.eq(members.callee("T", ".", "end"), 'T["end"]', "callee brackets a reserved word")
	t.eq(members.callee("T", ".", "continue"), "T.continue", "continue is contextual, so dot access holds")
	t.eq(members.callee("State", ":", "Connect"), "State:Connect", "colon join unchanged")

	local plain = tags.parse({})
	local privateDoc = tags.parse({ "@private" })
	t.eq(members.visibilityOf("run", plain, nil), "public", "visibility: plain name")
	t.eq(members.visibilityOf("_run", plain, nil), "private", "visibility: underscore prefix")
	t.eq(members.visibilityOf("_run", plain, true), "public", "visibility: exempt overrides prefix")
	t.eq(members.visibilityOf("run", privateDoc, true), "private", "visibility: @private beats exempt")

	local badges = members.buildBadges(
		tags.parse({ "@deprecated v2 -- use other", "@since v1.2", "@yields", "@server", "@client", "@tag util" })
	)
	t.eq(badges.deprecated, { version = "v2", note = "use other" }, "badges: deprecated")
	t.eq(badges.since, "v1.2", "badges: since")
	t.eq(badges.yields, true, "badges: yields")
	t.eq(badges.realm, { "server", "client" }, "badges: realm order")
	t.eq(badges.custom, { "util" }, "badges: custom tags")
	t.ok(members.buildBadges(plain).custom ~= members.buildBadges(plain).custom, "badges: custom cloned per member")

	local sharedFields = {}
	t.ok(
		members.symKey({ fields = sharedFields }) == members.symKey({ fields = sharedFields, castType = true }),
		"symKey: table identity survives cast clone"
	)
	local fnNode = {}
	t.ok(
		members.symKey({ fnNode = fnNode }) == members.symKey({ fnNode = fnNode, castType = true }),
		"symKey: function identity is its fnNode"
	)

	t.suite("model: finalize move policies")

	-- a tag-declared stub merges into the resident code member: docs win,
	-- code-derived signature and id stay
	local function codeMember(id: string, name: string, valueSym: any): any
		return {
			id = id,
			name = name,
			kind = "function",
			tags = { custom = {} },
			visibility = "public",
			signature = { callee = "W." .. name, segs = { "(x: number)" }, params = { { name = "x" } }, returns = {} },
			errors = {},
			source = { file = "src/w.luau", line = 5 },
			__valueSym = valueSym,
		}
	end
	local function stubMember(name: string): any
		return {
			id = "src/extra.luau#fn." .. name,
			name = name,
			kind = "function",
			doc = "tag prose",
			tags = { custom = { "storage" } },
			visibility = "public",
			signature = {
				callee = "W." .. name,
				segs = { "(x: number)" },
				params = { { name = "x", doc = "the x" } },
				returns = {},
			},
			errors = {},
			source = { file = "src/extra.luau", line = 2 },
		}
	end

	local diag1, ctx1 = fresh()
	local target1 = { name = "W", members = { codeMember("src/w.luau#fn.W.run", "run", {}) } }
	ctx1.containersByName.W = target1
	table.insert(ctx1.pendingMoves, { member = stubMember("run"), targetName = "W", fromModule = "src/extra.luau" })
	finalize.run(ctx1, EMPTY_GRAPH)
	t.eq(#target1.members, 1, "stub merged, not appended")
	t.eq(target1.members[1].id, "src/w.luau#fn.W.run", "code member keeps its id")
	t.eq(target1.members[1].doc, "tag prose", "tag prose wins")
	t.eq(target1.members[1].tags.custom, { "storage" }, "badges union")
	t.eq(target1.members[1].signature.params[1].doc, "the x", "param docs merge by name")
	t.eq(#diag1.list, 0, "clean merge reports nothing")

	-- require order inverted: the stub applied first, the code member arrives
	-- second and takes the slot (the merge is order-independent)
	local diag2, ctx2 = fresh()
	local stubFirst = stubMember("run")
	stubFirst.__valueSym = nil
	local target2 = { name = "W", members = { stubFirst } }
	ctx2.containersByName.W = target2
	table.insert(
		ctx2.pendingMoves,
		{ member = codeMember("src/w.luau#fn.Impl.run", "run", {}), targetName = "W", fromModule = "src/w.luau" }
	)
	finalize.run(ctx2, EMPTY_GRAPH)
	t.eq(#target2.members, 1, "swap keeps one member")
	t.eq(target2.members[1].id, "src/w.luau#fn.W.run", "code member re-minted under the target")
	t.eq(target2.members[1].doc, "tag prose", "stub prose survives the swap")
	t.eq(#diag2.list, 0, "swap reports nothing")

	-- two different CODE members on one name: the resident keeps it, the
	-- arrival is dropped and reported
	local diag3, ctx3 = fresh()
	local target3 = { name = "W", members = { codeMember("src/w.luau#fn.W.run", "run", {}) } }
	ctx3.containersByName.W = target3
	table.insert(
		ctx3.pendingMoves,
		{ member = codeMember("src/other.luau#fn.O.run", "run", {}), targetName = "W", fromModule = "src/other.luau" }
	)
	finalize.run(ctx3, EMPTY_GRAPH)
	t.eq(#target3.members, 1, "collision keeps the resident")
	t.eq(diag3.list[1] and diag3.list[1].code, "duplicate-within", "collision reported")

	-- an alias (same value under two names) merges silently
	local diag4, ctx4 = fresh()
	local aliasSym = {}
	local target4 = { name = "W", members = { codeMember("src/w.luau#fn.W.run", "run", aliasSym) } }
	ctx4.containersByName.W = target4
	table.insert(
		ctx4.pendingMoves,
		{ member = codeMember("src/w.luau#fn.W.go", "go", aliasSym), targetName = "W", fromModule = "src/w.luau" }
	)
	-- the arriving alias spells a different NAME, so it lands beside the
	-- original rather than colliding
	finalize.run(ctx4, EMPTY_GRAPH)
	t.eq(#target4.members, 2, "an alias under a new name is its own member")
	t.eq(#diag4.list, 0, "alias reports nothing")

	-- @within naming nothing warns
	local diag5, ctx5 = fresh()
	table.insert(
		ctx5.pendingMoves,
		{ member = stubMember("lost"), targetName = "Nowhere", fromModule = "src/extra.luau" }
	)
	finalize.run(ctx5, EMPTY_GRAPH)
	t.eq(diag5.list[1] and diag5.list[1].code, "orphaned-within", "unknown @within target warns")

	t.suite("model: finalize resolves a tag ref through any require")

	--- One prop typed by a tag ref naming `Dep`, in a module whose requires are
	--- `requires`. Nothing binds a local: the whole question is whether the
	--- require alone is enough to let the name resolve.
	local function refThroughRequires(requires: { string }): string?
		local _, ctx = fresh()
		local entry = entryWith("src/main.luau", "Main")
		local seg: any = { text = "Dep", __name = "Dep", __tag = true }
		table.insert(entry.members, {
			id = "src/main.luau#prop.Main.dep",
			name = "dep",
			kind = "prop",
			type = { seg },
			tags = { custom = {} },
			source = { file = "src/main.luau", line = 1 },
		})
		table.insert(ctx.modules, entry)
		ctx.containersByName.Dep =
			{ name = "Dep", id = "src/dep.luau#class.Dep", source = { file = "src/dep.luau" }, members = {} }
		local requireTargets: { [any]: string } = {}
		for _, id in requires do
			requireTargets[{}] = id -- keyed by SymValue identity, as the graph keys it
		end
		local g: any = {
			modules = {},
			byAbs = {},
			byId = { ["src/main.luau"] = { localModules = {}, requireTargets = requireTargets } },
		}
		finalize.run(ctx, g)
		return seg.id
	end

	-- `Flux = require(...)` straight into a table field never binds a local, so
	-- a `.Flux Flux` interface field has only the require to resolve through
	t.eq(
		refThroughRequires({ "src/dep.luau" }),
		"src/dep.luau#class.Dep",
		"a require with no local binding still links the name"
	)
	-- the gate itself: an unrelated module's class must not shadow a name this
	-- module never asked for
	t.eq(refThroughRequires({ "src/unrelated.luau" }), nil, "a module it does not require stays unlinked")
	t.eq(refThroughRequires({}), nil, "a module requiring nothing stays unlinked")

	t.suite("model: finalize type dedupe")

	local diag6, ctx6 = fresh()
	local entry6 = entryWith("src/a.luau", "A")
	local first = {
		id = "src/a.luau#type.T",
		name = "T",
		exported = false,
		generics = {},
		source = { file = "src/a.luau", line = 1 },
	}
	local exported = {
		id = "src/a.luau#type.T",
		name = "T",
		exported = true,
		generics = {},
		source = { file = "src/a.luau", line = 9 },
	}
	entry6.types = { first, exported }
	table.insert(ctx6.modules, entry6)
	finalize.run(ctx6, EMPTY_GRAPH)
	t.eq(#entry6.types, 1, "one declaration per id")
	t.eq(entry6.types[1].exported, true, "the exported declaration wins")
	t.eq(diag6.list[1] and diag6.list[1].code, "duplicate-type", "the loser is diagnosed")
	t.eq(diag6.list[1] and diag6.list[1].line, 1, "at the loser's line")

	t.suite("model: assembled over the tags fixture")

	local root = util.joinPath(paths.projectFixtures, "tags-project")
	local g, buildDiag = t.buildGraph(root, "src/init.luau")
	local doc = model.assemble(g, buildDiag, { entryPoints = { "src/init.luau" } })

	t.eq(doc.schemaVersion, 1, "schema version stamped")
	t.eq(#buildDiag.list, 1, "the tag-torture fixture assembles with only the ignored-tag info")
	t.eq(buildDiag.list[1] and buildDiag.list[1].code, "ignored-tag", "@__index reports ignored-tag")
	t.eq(doc.externals, { Promise = "https://eryn.io/roblox-lua-promise/lib/" }, "@external binds name to url")

	local init = byId(doc.modules, "src/init.luau")
	local widgetMod = byId(doc.modules, "src/Widget.luau")
	t.ok(init ~= nil and widgetMod ~= nil, "both fixture modules assemble")

	-- init: the Tagged root class plus the Draft orphan (factory pattern)
	local tagged = byName(init.classes, "Tagged")
	local draft = byName(init.classes, "Draft")
	t.ok(tagged ~= nil, "root @class Tagged")
	t.ok(draft ~= nil, "orphan @class Draft declared off the surface")
	t.eq(byName(draft.members, "discard").kind, "method", "orphan class members build")

	local create = byName(tagged.members, "create")
	t.eq(segs.text(create.signature.segs), "(name: string): Widget.Widget", "signature display from segments")
	t.eq(create.signature.params[1].doc, "the display name", "@param doc merged by name")
	t.eq(wireSegs(create.signature.params[1].type), { { text = "string" } }, "@param type override is a tag ref")
	t.eq(create.signature.returns[1].doc, "the new widget", "@return doc merged positionally")

	local save = byName(tagged.members, "save")
	t.eq(save.tags.yields, true, "@yields badge")
	t.eq(save.tags.realm, { "server", "plugin" }, "realm badges in fixed order")
	t.eq(save.errors[1], { type = "string", doc = "when the datastore is unavailable" }, "@error captured")

	local make = byName(tagged.members, "make")
	t.eq(make.tags.deprecated, { version = "v2", note = "use [Tagged.create] instead" }, "@deprecated badge")
	t.eq(make.tags.since, "v0.9.0", "@since badge")

	-- code-signal detection through the pipeline; the permutations live in
	-- detect.spec, these pin that buildFn reads them into the badge slots
	t.eq(byName(tagged.members, "flush").tags.yields, true, "yields detected from the body, no tag")
	t.eq(byName(tagged.members, "mirror").tags.realm, { "server" }, "an explicit realm tag beats detection")
	local limits = byName(init.classes, "Limits")
	t.eq(byName(limits.members, "maxWidgets").readonly, true, "a frozen container's props are read-only")
	-- Caps and Limits are one table: the first name took the section, and the
	-- second is typed as the link to it rather than left bare beside it
	t.eq(
		wireSegs(byName(tagged.members, "Caps").type),
		{ { id = limits.id, text = "Limits" } },
		"a prop aliasing a documented container is typed as that container"
	)

	-- `Tagged.blank = Widget.new("")` declares no type: finalize walks to
	-- Widget.new across the require and takes what it returns. The ref was
	-- spelled in Widget.luau, so it resolves in that module's scope, not this
	-- one, where the bare name `Widget` is bound to the module instead.
	t.eq(
		wireSegs(byName(tagged.members, "blank").type),
		{ { id = "src/Widget.luau#type.Widget", text = "Widget" } },
		"a prop assigned a call takes the callee's annotated return"
	)

	-- one untagged expression, `RunService:IsServer() and script.Storage`,
	-- feeding both slots: the guard says where the value is, the guarded half
	-- says what it is
	local storage = byName(tagged.members, "storage")
	t.eq(storage.tags.realm, { "server" }, "a conditional mount badges the realm it mounts in")
	t.eq(wireSegs(storage.type), { { text = "Instance" }, "?" }, "and types the mounted value optional")

	t.eq(byName(tagged.members, "internalReset").visibility, "private", "@private drives visibility")
	t.eq(byName(tagged.members, "debugDump"), nil, "@ignore drops the member")
	local preview = byName(tagged.members, "preview")
	t.eq(preview.tags.unreleased, true, "@unreleased badge")
	-- the record itself is empty, so only the scratch marker keeps it an
	-- object on the wire; the capture pins the resulting `{}` byte-for-byte
	t.eq(emitMod.encode(preview.tags.deprecated), "{}", "bare @deprecated emits an object, never []")

	-- the whole-module mount is a re-export, not a member
	t.eq(init.reexports[1].name, "Widget", "module mount is a re-export")
	t.eq(init.reexports[1].targetModule, "src/Widget.luau", "re-export resolves to the defining module")
	t.eq(init.reexports[1].targetMember, nil, "a whole-module mount names no member")

	-- CreatePolicy: declared in Widget.luau, moved onto the Tagged page
	local policy = byName(init.types, "CreatePolicy")
	t.ok(policy ~= nil, "@within moves an export type across modules")
	t.eq(policy.id, "src/Widget.luau#type.CreatePolicy", "a moved decl keeps its minted id")

	-- Widget: root class, the dotted floating class, and the relocations
	local widget = byName(widgetMod.classes, "Widget")
	local skin = byName(widgetMod.classes, "Widget.Skin")
	t.ok(widget ~= nil, "root @class Widget")
	t.ok(skin ~= nil, "a floating dotted @class keeps the whole name")
	t.eq(byName(skin.members, "border").kind, "prop", "@prop lands on the dotted class via @within")

	t.eq(byName(widget.members, "version").readonly, true, "@readonly badge")
	-- `Widget.slots = {}` would infer `{}`; the floating @prop in extra.luau
	-- outranks it, unlike a code annotation, which the value cannot contradict
	t.eq(
		wireSegs(byName(widget.members, "slots").type),
		{ "{ ", { text = "string" }, " }" },
		"a floating @prop type outranks an inferred one"
	)
	t.eq(byName(widget.members, "rename").kind, "method", "colon definition is a method")
	t.eq(byName(widget.members, "activate").tags.realm, { "client" }, "realm detected from the body, no tag")

	local reskin = byName(widget.members, "reskin")
	t.eq(
		reskin.signature.params[2].doc,
		"multiplier against the base size",
		"a trailing comment documents its parameter"
	)
	t.eq(reskin.signature.params[1].doc, "the tag wins over the trailing comment", "@param outranks the trailer")
	-- constructors group under the class they CONSTRUCT: create/make return
	-- Widget's classType (via the @return tag convention), new returns
	-- setmetatable(_, Widget); all three are Widget constructors
	t.eq(widget.constructors, {
		byName(tagged.members, "create").id,
		byName(tagged.members, "make").id,
		byName(widget.members, "new").id,
	}, "constructor detection: tag-returned class type and setmetatable return")

	local load = byName(widget.members, "load")
	local loadSegs = wireSegs(load.signature.segs)
	t.eq(loadSegs[#loadSegs], { text = "Promise" }, "an undeclared type stays an id-less ref for the renderer")

	-- @ignore on a type must also unregister it: a ref to it carrying the
	-- pre-registered id would dangle (and mask the by-text fallback)
	t.eq(byName(widgetMod.types, "Internal"), nil, "@ignore drops the type declaration")
	local capture = byName(widget.members, "capture")
	local captureSegs = wireSegs(capture.signature.segs)
	t.eq(captureSegs[#captureSegs], { text = "Internal" }, "a ref to an @ignored type carries no dangling id")

	-- ...but the registration is per NAME, shared with same-named siblings:
	-- unregistering waits until no decl under the name was emitted, so the
	-- kept WidgetBase still resolves refs despite its @ignored duplicate
	local snapshot = byName(widgetMod.types, "Snapshot")
	t.eq(
		wireSegs(snapshot.definition[1])[1],
		{ text = "WidgetBase", id = "src/Widget.luau#type.WidgetBase" },
		"a kept decl sharing an @ignored duplicate's name keeps its ref id"
	)

	-- moonwave manual mode: members declared in extra.luau land on Widget
	t.eq(byName(widget.members, "theme").kind, "prop", "floating @prop relocates")
	t.eq(
		wireSegs(byName(widget.members, "owner").type),
		{ { text = "Tagged" } },
		"a tag ref to a module the file neither binds nor lands in stays plain"
	)
	local describe = byName(widget.members, "describe")
	t.eq(describe.kind, "function", "floating @function relocates")
	t.eq(describe.signature.returns[1].doc, "a human-readable description", "JSDoc dash split")
	local refresh = byName(widget.members, "refresh")
	t.eq(refresh.kind, "method", "@method Widget:refresh colon form")
	t.eq(refresh.signature.callee, "Widget:refresh", "colon form renders a colon callee")
	t.eq(byName(widget.members, "persist").signature.callee, "Widget.persist", "@within retargets the callee")

	-- types: the interface block, dot-fields, @field merging
	local options = byName(widgetMod.types, "WidgetOptions")
	t.eq(options.kind, "interface", "@interface declares an interface")
	t.eq(
		{ name = options.fields[2].name, type = wireSegs(options.fields[2].type), doc = options.fields[2].doc },
		{ name = "scale", type = { { text = "number" }, "?" }, doc = "render scale" },
		"dot-field with optional type"
	)

	local manifest = byName(widgetMod.types, "Manifest")
	t.eq(manifest.kind, "interface", "@interface on a real alias declares an interface")
	t.eq(manifest.definition, nil, "a typeof definition spelling no fields cedes to the dot-fields")
	t.eq(#manifest.fields, 2, "dot-fields split by a blank line all parse")
	t.eq(manifest.fields[2].name, "locked", "the post-blank dot-field keeps its own entry")

	local widen = byName(widgetMod.types, "Widen")
	t.eq(widen.kind, "typefunction", "type function kind survives")
	t.eq(widen.definition, nil, "a type function binds no type expression")
	t.eq(segs.text(widen.params), "(ty: type)", "type function fence carries its parameter list")

	local phase = byName(widgetMod.types, "Phase")
	t.eq(
		segs.blockText(phase.definition),
		'"idle"\n\t| "active"\n\t| "retired"',
		"a wrapped union keeps its continuation indent"
	)

	local renameOptions = byName(widgetMod.types, "RenameOptions")
	local changed = byName(renameOptions.fields, "changed")
	t.eq(changed.doc, "Fired when the rename lands.", "leading field doc claims")
	t.eq(changed.docInDisplay, true, "claimed doc is already in the display")
	t.eq(byName(renameOptions.fields, "silent").doc, "skip events", "trailing field doc")
	t.eq(byName(renameOptions.fields, "validate").doc, "reject empty names", "@field overrides the code walk")

	t.eq(byName(snapshot.fields, "frozen").doc, "no further updates", "@field documents an intersection operand")
	t.ok(byName(snapshot.fields, "frozen").line ~= nil, "operand field still names its display line")

	local themeName = byName(widgetMod.types, "ThemeName")
	t.eq(wireLines(themeName.definition), { { { text = "string" } } }, "floating @type definition is a one-line block")
	t.eq(themeName.doc, "a theme identifier", "trailing desc on the @type line")

	-- extra.luau is tags-only: everything moved away, no members remain
	local extraMod = byId(doc.modules, "src/extra.luau")
	t.eq(#extraMod.members, 0, "a tags-only module keeps no members")
	t.eq(#extraMod.types, 0, "a tags-only module keeps no unmoved types")

	t.suite("model: passthrough (aliasOf)")

	-- everything downstream of aliasOf (page suppression, nav edges, badge
	-- retargeting) is renderer behavior over hand-written models, so this is
	-- the one place pinning that the extractor emits the field at all
	local aliasRoot = util.joinPath(paths.fixtures, "alias")
	local aliasGraph, aliasDiag = t.buildGraph(aliasRoot, "main.luau")
	local aliasDoc = model.assemble(aliasGraph, aliasDiag, { entryPoints = { "main.luau" } })

	t.eq(#aliasDiag.list, 0, "the alias fixture assembles cleanly")
	t.eq(byId(aliasDoc.modules, "main.luau").aliasOf, "impl.luau", "`return require(X)` emits aliasOf naming X")
	local impl = byId(aliasDoc.modules, "impl.luau")
	t.eq(impl.aliasOf, nil, "the chain ends at the module that returns a value")
	t.ok(byName(impl.members, "greet") ~= nil, "a module reached only through a passthrough still surfaces")
end
