local t = require("./harness")
local util = require("../util")
local graph = require("../graph")
local surface = require("../surface")
local tags = require("../tags")
local segs = require("../segs")
local model = require("../model")
local emitMod = require("../emit")
local members = require("../model/members")
local finalize = require("../model/finalize")

local byName = t.byName
local byId = t.byId

local function fresh(): (any, any)
	local diag = util.diagnostics()
	return diag, members.newCtx(diag)
end

local function wireSegs(list: { any }?): any
	if list == nil then
		return nil
	end
	local out = {}
	for _, seg in list do
		table.insert(
			out,
			if type(seg) == "string"
				then seg
				elseif seg.id ~= nil then { text = seg.text, id = seg.id }
				else { text = seg.text }
		)
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

local EMPTY_GRAPH: any = { modules = {}, byId = {}, byAbs = {} }

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

local function assembleInline(
	specs: { { id: string, src: string, surfaced: boolean? } },
	reportUndoc: boolean?
): (any, any)
	local diag = util.diagnostics()
	local g: any = { modules = {}, byId = {}, byAbs = {} }
	for _, s in specs do
		local parsed, claimIndex, trailingIndex, blocks = t.parseWithComments(s.src)
		local surf = surface.evaluate(parsed, claimIndex, trailingIndex)
		local requireTargets: { [any]: string } = {}
		local localModules: { [string]: string } = {}
		local function linkReq(sym: any): string?
			if sym == nil or sym.kind ~= "require" or sym.requireInfo == nil or sym.requireInfo.text == nil then
				return nil
			end
			local targetId = sym.requireInfo.text:gsub("^[%.@%w_]+/", "") .. ".luau"
			requireTargets[sym] = targetId
			return targetId
		end
		for _, reqSym in graph.collectSurfacedRequires(surf.result) do
			linkReq(reqSym)
		end
		for name, sym in surf.requireLocals do
			local targetId = linkReq(sym)
			if targetId ~= nil then
				localModules[name] = targetId
			end
		end
		local name = util.stem(s.id)
		local mod = {
			id = s.id,
			absPath = "/" .. s.id,
			name = name,
			instancePath = { name },
			surfaced = s.surfaced ~= false,
			parsed = parsed,
			blocks = blocks,
			claimIndex = claimIndex,
			trailingIndex = trailingIndex,
			surface = surf,
			requireTargets = requireTargets,
			requireFailures = {},
			localModules = localModules,
			externalRequires = {},
			localExternals = {},
		}
		table.insert(g.modules, mod)
		g.byId[s.id] = mod
	end
	return model.assemble(g, diag, { entryPoints = { specs[1].id }, reportUndocumented = reportUndoc }), diag
end

return function()
	t.suite("model: shared helpers")

	t.eq({
		members.mergeDescs(nil, nil),
		members.mergeDescs("a", nil),
		members.mergeDescs(nil, "b"),
		members.mergeDescs("a", "a"),
		members.mergeDescs("a", "b"),
		members.mergeDescs("", "b"),
	}, { nil, "a", "b", "a", "a\n\nb", "b" }, "mergeDescs")

	t.eq({
		members.memberId("src/a.luau", "fn", nil, "run"),
		members.memberId("src/a.luau", "prop", "Widget", "size"),
		members.memberId("src/a.luau", "prop", "", "size"),
	}, { "src/a.luau#fn.run", "src/a.luau#prop.Widget.size", "src/a.luau#prop.size" }, "memberId")

	t.eq({
		members.callee("Fonts", ".", "12187368317"),
		members.callee("T", ".", "end"),
		members.callee("T", ".", "continue"),
		members.callee("State", ":", "Connect"),
	}, { 'Fonts["12187368317"]', 'T["end"]', "T.continue", "State:Connect" }, "callee")

	local plain = tags.parse({})
	local privateDoc = tags.parse({ "@private" })
	t.eq({
		members.visibilityOf("run", plain, nil),
		members.visibilityOf("_run", plain, nil),
		members.visibilityOf("_run", plain, true),
		members.visibilityOf("run", privateDoc, true),
	}, { "public", "private", "public", "private" }, "visibilityOf")

	local badges = members.buildBadges(
		tags.parse({ "@deprecated v2 -- use other", "@since v1.2", "@yields", "@server", "@client", "@tag util" })
	)
	t.eq(badges, {
		deprecated = { version = "v2", note = "use other" },
		since = "v1.2",
		yields = true,
		realm = { "server", "client" },
		custom = { "util" },
	}, "buildBadges")
	t.ok(members.buildBadges(plain).custom ~= members.buildBadges(plain).custom, "custom tags cloned per member")

	local sharedFields, fnNode = {}, {}
	t.ok(
		members.symKey({ fields = sharedFields }) == members.symKey({ fields = sharedFields, castType = true }),
		"symKey table"
	)
	t.ok(members.symKey({ fnNode = fnNode }) == members.symKey({ fnNode = fnNode, castType = true }), "symKey fnNode")

	t.suite("model: finalize move and dedupe policies")

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
	local m1 = target1.members[1]
	t.eq(
		{ #target1.members, m1.id, m1.doc, m1.tags.custom, m1.signature.params[1].doc, #diag1.list },
		{ 1, "src/w.luau#fn.W.run", "tag prose", { "storage" }, "the x", 0 },
		"stub merges into resident code member"
	)

	local diag2, ctx2 = fresh()
	local target2 = { name = "W", members = { stubMember("run") } }
	ctx2.containersByName.W = target2
	table.insert(
		ctx2.pendingMoves,
		{ member = codeMember("src/w.luau#fn.Impl.run", "run", {}), targetName = "W", fromModule = "src/w.luau" }
	)
	finalize.run(ctx2, EMPTY_GRAPH)
	t.eq(
		{ #target2.members, target2.members[1].id, target2.members[1].doc, #diag2.list },
		{ 1, "src/w.luau#fn.W.run", "tag prose", 0 },
		"code member arriving after stub promotes into slot"
	)

	local diag3, ctx3 = fresh()
	ctx3.containersByName.W = { name = "W", members = { codeMember("src/w.luau#fn.W.run", "run", {}) } }
	table.insert(
		ctx3.pendingMoves,
		{ member = codeMember("src/other.luau#fn.O.run", "run", {}), targetName = "W", fromModule = "src/other.luau" }
	)
	finalize.run(ctx3, EMPTY_GRAPH)
	t.eq({ #ctx3.containersByName.W.members, diag3.list[1].code }, { 1, "duplicate-within" }, "distinct code collision")

	local diag4, ctx4 = fresh()
	local aliasSym = {}
	ctx4.containersByName.W = { name = "W", members = { codeMember("src/w.luau#fn.W.run", "run", aliasSym) } }
	table.insert(
		ctx4.pendingMoves,
		{ member = codeMember("src/w.luau#fn.W.go", "go", aliasSym), targetName = "W", fromModule = "src/w.luau" }
	)
	finalize.run(ctx4, EMPTY_GRAPH)
	t.eq({ #ctx4.containersByName.W.members, #diag4.list }, { 2, 0 }, "alias under new name is kept")

	local diag5, ctx5 = fresh()
	table.insert(
		ctx5.pendingMoves,
		{ member = stubMember("lost"), targetName = "Nowhere", fromModule = "src/extra.luau" }
	)
	finalize.run(ctx5, EMPTY_GRAPH)
	t.eq(diag5.list[1].code, "orphaned-within", "unknown @within target warns")

	local diag7, ctx7 = fresh()
	local code7 = codeMember("src/w.luau#fn.W.run", "run", {})
	ctx7.containersByName.W = { name = "W", members = { code7 } }
	local stub7 = stubMember("run")
	stub7.signature.params = { { name = "x", type = { "number" } }, { name = "ghost", type = { "string" } } }
	stub7.signature.returns = { { type = { "boolean" }, doc = "whether it ran" } }
	table.insert(ctx7.pendingMoves, { member = stub7, targetName = "W", fromModule = "src/extra.luau" })
	finalize.run(ctx7, EMPTY_GRAPH)
	t.eq({
		code7.signature.returns,
		segs.text(code7.signature.segs),
		#code7.signature.params,
		{ diag7.list[1].code, diag7.list[1].file, diag7.list[1].line },
	}, {
		{ { type = { "boolean" }, doc = "whether it ran" } },
		"(x: number): boolean",
		1,
		{ "param-mismatch", "src/extra.luau", 2 },
	}, "stub signature merge and param-mismatch diagnostic")

	local diag8, ctx8 = fresh()
	local entry8 = entryWith("src/w.luau", "W")
	local twin = codeMember("src/w.luau#fn.W.run", "run", {})
	twin.source = { file = "src/w.luau", line = 9 }
	entry8.members = { codeMember("src/w.luau#fn.W.run", "run", {}), twin }
	table.insert(ctx8.modules, entry8)
	finalize.run(ctx8, EMPTY_GRAPH)
	t.eq(
		{ #entry8.members, entry8.members[1].source.line, diag8.list[1].code, diag8.list[1].line },
		{ 1, 5, "duplicate-member", 9 },
		"duplicate member id deduplication"
	)

	local diag6, ctx6 = fresh()
	local entry6 = entryWith("src/a.luau", "A")
	entry6.types = {
		{
			id = "src/a.luau#type.T",
			name = "T",
			exported = false,
			generics = {},
			source = { file = "src/a.luau", line = 1 },
		},
		{
			id = "src/a.luau#type.T",
			name = "T",
			exported = true,
			generics = {},
			source = { file = "src/a.luau", line = 9 },
		},
	}
	table.insert(ctx6.modules, entry6)
	finalize.run(ctx6, EMPTY_GRAPH)
	t.eq(
		{ #entry6.types, entry6.types[1].exported, diag6.list[1].code, diag6.list[1].line },
		{ 1, true, "duplicate-type", 1 },
		"exported type wins duplicate-type dedupe"
	)

	t.suite("model: finalize resolves tag ref through any require")

	local function refThroughRequires(reqs: { string }): string?
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
		for _, id in reqs do
			requireTargets[{}] = id
		end
		finalize.run(
			ctx,
			{
				modules = {},
				byAbs = {},
				byId = { ["src/main.luau"] = { localModules = {}, requireTargets = requireTargets } },
			} :: any
		)
		return seg.id
	end
	t.eq(
		{ refThroughRequires({ "src/dep.luau" }), refThroughRequires({ "src/unrelated.luau" }), refThroughRequires({}) },
		{ "src/dep.luau#class.Dep", nil, nil },
		"tag ref resolves only when defining module is required"
	)

	t.suite("model: container type fallback, nested reexports, respelled types, and opaque deep index")

	local inlineDoc, inlineDiag = assembleInline({
		{
			id = "M.luau",
			src = table.concat({
				'local Sub = require("./Sub")',
				'local Clock = require("./Clock")',
				'local Util = require("./Util")',
				"export type M = {",
				"\t--- count of items",
				"\tread x: number,",
				"\t--- setup callback",
				"\tinit: () -> (),",
				"}",
				"export type Foo<T> = Sub.Foo<T>",
				"export type Bar = Sub.Bar",
				"export type MaybeFoo<T> = Sub.Foo<T>?",
				"export type function Inspect(box: Sub.Foo<string>)",
				"\treturn box",
				"end",
				"--- @prop hidden number",
				"--- @ignore",
				"local M: M = { x = 1, init = nil :: any }",
				"M.Clock = table.freeze({ now = Clock.now })",
				"M.LocalPlayer = Util.Service.Players.LocalPlayer",
				"function M.clock()",
				'\treturn require("./Clock")',
				"end",
				"return M",
			}, "\n"),
		},
		{
			id = "Sub.luau",
			surfaced = false,
			src = table.concat({
				"local Sub = {}",
				"--- A generic box.",
				"export type Foo<T> = {",
				"\t--- boxed value",
				"\tvalue: T,",
				"}",
				"export type Bar<T = string> = { item: T }",
				"return Sub",
			}, "\n"),
		},
		{
			id = "Clock.luau",
			src = "local Clock = {}\nfunction Clock.now(): number return 0 end\nreturn Clock",
		},
		{
			id = "Util.luau",
			surfaced = false,
			src = 'return { Service = { Players = game:GetService("Players") } }',
		},
	})
	t.eq(#inlineDiag.list, 0, "inline multi-module model assembles with zero diagnostics")

	local mMod = byId(inlineDoc.modules, "M.luau")
	local propX = byName(mMod.members, "x")
	local propInit = byName(mMod.members, "init")
	t.eq(
		{ wireSegs(propX.type), propX.doc, propX.readonly, segs.text(propInit.type), propInit.doc },
		{ { { text = "number" } }, "count of items", true, "() -> ()", "setup callback" },
		"container table type annotation fallback supplies types, docs, and readonly"
	)

	local nowReexport = byName(mMod.reexports, "now")
	t.eq(
		{ nowReexport.within, nowReexport.targetModule, nowReexport.targetId },
		{ "M.Clock", "Clock.luau", "Clock.luau#fn.Clock.now" },
		"nested container re-export sets within = M.Clock"
	)

	local fooType = byName(mMod.types, "Foo")
	local barType = byName(mMod.types, "Bar")
	local maybeFoo = byName(mMod.types, "MaybeFoo")
	local inspectFn = byName(mMod.types, "Inspect")
	t.eq({
		fooType.doc,
		t.blockText(fooType.definition),
		fooType.fields,
		barType.generics[1].name,
		wireSegs(barType.generics[1].default),
		wireSegs(maybeFoo.definition[1]),
		wireSegs(inspectFn.params),
		byName(mMod.members, "hidden"),
	}, {
		"A generic box.",
		"{\n\t--- boxed value\n\tvalue: T,\n}",
		{ { name = "value", type = { "T" }, doc = "boxed value", line = 3, docInDisplay = true } },
		"T",
		{ { text = "string" } },
		{ { text = "Sub.Foo", id = "M.luau#type.Foo" }, "<T>?" },
		{ "(", "box", ": ", { text = "Sub.Foo", id = "M.luau#type.Foo" }, "<", { text = "string" }, ">", ")" },
		nil,
	}, "expandRespelledTypes, composite Sub.Foo<T>?, type function params, and floating @ignore")

	local lpProp = byName(mMod.members, "LocalPlayer")
	t.eq(
		{ lpProp.kind, wireSegs(lpProp.type), byName(mMod.reexports, "LocalPlayer") },
		{ "prop", { { text = "Player" } }, nil },
		"deep indexing into opaque service converts to Prop typed Player without unresolved-reexport"
	)

	local clockFn = byName(mMod.members, "clock")
	t.eq(
		{ segs.text(clockFn.signature.segs), wireSegs(clockFn.signature.returns[1].type) },
		{ "(): Clock", { { text = "Clock", id = "Clock.luau" } } },
		"lazy loader returnedRequire resolves return type to target module"
	)

	t.suite("model: assembled over the tags fixture")

	local root = util.joinPath(t.projectFixtures, "tags-project")
	local g, buildDiag = t.buildGraph(root, "src/init.luau")
	local doc = model.assemble(g, buildDiag, { entryPoints = { "src/init.luau" } })

	t.eq(
		{ doc.schemaVersion, #buildDiag.list, buildDiag.list[1].code, doc.externals },
		{ 1, 1, "ignored-tag", { Promise = "https://eryn.io/roblox-lua-promise/lib/" } },
		"schema, ignored-tag diagnostic, and @external"
	)

	local init = byId(doc.modules, "src/init.luau")
	local widgetMod = byId(doc.modules, "src/Widget.luau")
	local tagged = byName(init.classes, "Tagged")
	local draft = byName(init.classes, "Draft")
	local limits = byName(init.classes, "Limits")
	t.eq(byName(draft.members, "discard").kind, "method", "orphan @class Draft method")

	local create = byName(tagged.members, "create")
	t.eq({
		segs.text(create.signature.segs),
		create.signature.params[1].doc,
		wireSegs(create.signature.params[1].type),
		create.signature.returns[1].doc,
	}, {
		"(name: string): Widget",
		"the display name",
		{ { text = "string" } },
		"the new widget",
	}, "Tagged.create signature and merged @param/@return")

	local save = byName(tagged.members, "save")
	local make = byName(tagged.members, "make")
	local preview = byName(tagged.members, "preview")
	local storage = byName(tagged.members, "storage")
	t.eq(
		{
			save.tags.yields,
			save.tags.realm,
			save.errors[1],
			make.tags.deprecated,
			make.tags.since,
			byName(tagged.members, "flush").tags.yields,
			byName(tagged.members, "mirror").tags.realm,
			byName(limits.members, "maxWidgets").readonly,
			wireSegs(byName(tagged.members, "Caps").type),
			wireSegs(byName(tagged.members, "blank").type),
			storage.tags.realm,
			wireSegs(storage.type),
			byName(tagged.members, "internalReset").visibility,
			byName(tagged.members, "debugDump"),
			preview.tags.unreleased,
			emitMod.encode(preview.tags.deprecated),
		},
		{
			true,
			{ "server", "plugin" },
			{ type = "string", doc = "when the datastore is unavailable" },
			{ version = "v2", note = "use [Tagged.create] instead" },
			"v0.9.0",
			true,
			{ "server" },
			true,
			{ { id = limits.id, text = "Limits" } },
			{ { id = "src/Widget.luau#type.Widget", text = "Widget" } },
			{ "server" },
			{ { text = "Instance" }, "?" },
			"private",
			nil,
			true,
			"{}",
		},
		"Tagged badges, container alias type, call return inference, conditional mount, visibility, and bare @deprecated"
	)

	t.eq(
		{ init.reexports[1].name, init.reexports[1].targetModule, init.reexports[1].targetMember },
		{ "Widget", "src/Widget.luau", nil },
		"whole-module mount re-export"
	)
	t.eq(byName(init.types, "CreatePolicy").id, "src/Widget.luau#type.CreatePolicy", "@within moved type")

	local widget = byName(widgetMod.classes, "Widget")
	local skin = byName(widgetMod.classes, "Widget.Skin")
	local reskin = byName(widget.members, "reskin")
	local describe = byName(widget.members, "describe")
	local refresh = byName(widget.members, "refresh")
	local loadSegs = wireSegs(byName(widget.members, "load").signature.segs)
	local captureSegs = wireSegs(byName(widget.members, "capture").signature.segs)
	t.eq({
		byName(skin.members, "border").kind,
		byName(widget.members, "version").readonly,
		wireSegs(byName(widget.members, "slots").type),
		byName(widget.members, "rename").kind,
		byName(widget.members, "activate").tags.realm,
		reskin.signature.params[1].doc,
		reskin.signature.params[2].doc,
		widget.constructors,
		loadSegs[#loadSegs],
		byName(widgetMod.types, "Internal"),
		captureSegs[#captureSegs],
		byName(widget.members, "theme").kind,
		wireSegs(byName(widget.members, "owner").type),
		describe.kind,
		segs.text(describe.signature.segs),
		describe.signature.returns[1].doc,
		refresh.kind,
		refresh.signature.callee,
		byName(widget.members, "persist").signature.callee,
	}, {
		"prop",
		true,
		{ "{ ", { text = "string" }, " }" },
		"method",
		{ "client" },
		"the tag wins over the trailing comment",
		"multiplier against the base size",
		{ create.id, make.id, byName(widget.members, "new").id },
		{ text = "Promise" },
		nil,
		{ text = "Internal" },
		"prop",
		{ { text = "Tagged" } },
		"function",
		"(widget: Widget): string",
		"a human-readable description",
		"method",
		"Widget:refresh",
		"Widget.persist",
	}, "Widget members, constructors, @ignored type unregistration, and Moonwave manual relocations")

	local snapshot = byName(widgetMod.types, "Snapshot")
	local options = byName(widgetMod.types, "WidgetOptions")
	local manifest = byName(widgetMod.types, "Manifest")
	local widen = byName(widgetMod.types, "Widen")
	local phase = byName(widgetMod.types, "Phase")
	local renameOptions = byName(widgetMod.types, "RenameOptions")
	local changed = byName(renameOptions.fields, "changed")
	local themeName = byName(widgetMod.types, "ThemeName")
	local extraMod = byId(doc.modules, "src/extra.luau")
	t.eq({
		wireSegs(snapshot.definition[1])[1],
		options.kind,
		{ name = options.fields[2].name, type = wireSegs(options.fields[2].type), doc = options.fields[2].doc },
		manifest.kind,
		manifest.definition,
		#manifest.fields,
		manifest.fields[2].name,
		widen.kind,
		widen.definition,
		segs.text(widen.params),
		t.blockText(phase.definition),
		changed.doc,
		changed.docInDisplay,
		byName(renameOptions.fields, "silent").doc,
		byName(renameOptions.fields, "validate").doc,
		byName(snapshot.fields, "frozen").doc,
		byName(snapshot.fields, "frozen").line ~= nil,
		wireLines(themeName.definition),
		themeName.doc,
		#extraMod.members,
		#extraMod.types,
	}, {
		{ text = "WidgetBase", id = "src/Widget.luau#type.WidgetBase" },
		"interface",
		{ name = "scale", type = { { text = "number" }, "?" }, doc = "render scale" },
		"interface",
		nil,
		2,
		"locked",
		"typefunction",
		nil,
		"(ty: type)",
		'"idle"\n\t| "active"\n\t| "retired"',
		"Fired when the rename lands.",
		true,
		"skip events",
		"reject empty names",
		"no further updates",
		true,
		{ { { text = "string" } } },
		"a theme identifier",
		0,
		0,
	}, "Widget types, interfaces, typefunction, field docs, and tags-only module cleanup")

	t.suite("model: passthrough, implicit classes, conditional mount, reportUndocumented, and runtime aliases")

	local aliasGraph, aliasDiag = t.buildGraph(util.joinPath(t.fixtures, "alias"), "main.luau")
	local aliasDoc = model.assemble(aliasGraph, aliasDiag, { entryPoints = { "main.luau" } })
	local impl = byId(aliasDoc.modules, "impl.luau")
	t.eq({
		#aliasDiag.list,
		byId(aliasDoc.modules, "main.luau").aliasOf,
		impl.aliasOf,
		byName(impl.members, "greet") ~= nil,
	}, { 0, "impl.luau", nil, true }, "passthrough aliasOf")

	local classesRoot = util.joinPath(t.fixtures, "classes")
	local classesGraph, classesDiag = t.buildGraph(classesRoot, "main.luau")
	local classesDoc = model.assemble(classesGraph, classesDiag, { entryPoints = { "main.luau" } })
	local classesMod = byId(classesDoc.modules, "main.luau")
	local classNames = {}
	for _, class in classesMod.classes do
		table.insert(classNames, class.name)
	end
	table.sort(classNames)
	local counter = byName(classesMod.classes, "Counter")
	local bump = byName(counter.members, "bump")
	local timer = byName(classesMod.classes, "Timer")
	local cursor = byName(classesMod.classes, "cursorImpl")
	local signalMod = byId(classesDoc.modules, "Signal.luau")
	local signal = byName(signalMod.classes, "Signal")
	t.eq({
		#classesDiag.list,
		classNames,
		counter.doc,
		counter.constructors,
		bump.kind,
		bump.signature.callee,
		segs.text(bump.signature.segs),
		bump.signature.params[1].name,
		byName(counter.members, "get").signature.callee,
		timer.constructors,
		byName(timer.members, "elapsed").signature.callee,
		cursor.constructors,
		byName(cursor.members, "advance").signature.callee,
		byName(classesMod.types, "Counter") ~= nil,
		#classesMod.members,
		byName(classesMod.members, "find") ~= nil,
		byName(classesMod.members, "defaults").kind,
		byName(classesMod.members, "limits").kind,
		segs.text(byName(classesMod.members, "limits").type),
		byName(classesMod.members, "reset") ~= nil,
		byName(classesMod.types, "Resettable").doc,
		#signalMod.members,
		signal.constructors,
		byName(signal.members, "DisconnectAll") ~= nil,
	}, {
		0,
		{ "Counter", "Timer", "cursorImpl" },
		"Counts up.",
		{ "main.luau#fn.main.counter" },
		"method",
		"Counter:bump",
		"(by: number?): number",
		"by",
		"Counter:get",
		{ "main.luau#fn.main.timer" },
		"Timer:elapsed",
		{ "main.luau#fn.main.cursor" },
		"cursorImpl:advance",
		true,
		8,
		true,
		"prop",
		"prop",
		"{ max: number }",
		true,
		nil,
		0,
		{ "Signal.luau#fn.Signal.new" },
		true,
	}, "implicit classes, explicit-self methods, table props, and orphan constructor dedupe")

	local stringsGraph, stringsDiag = t.buildGraph(util.joinPath(t.fixtures, "strings"), "main.luau")
	local stringsDoc = model.assemble(stringsGraph, stringsDiag, { entryPoints = { "main.luau" } })
	local innerMount = byName(byId(stringsDoc.modules, "b/init.luau").reexports, "inner")
	t.eq({ innerMount.targetModule, innerMount.realm }, { "b/inner.luau", { "server" } }, "conditional mount re-export")

	local undocGraph, undocDiag = t.buildGraph(classesRoot, "main.luau")
	model.assemble(undocGraph, undocDiag, { entryPoints = { "main.luau" }, reportUndocumented = true })
	local undocumented = {}
	for _, d in undocDiag.list do
		table.insert(undocumented, { d.code, d.severity, d.line, d.message })
	end
	t.eq(undocumented, {
		{ "undocumented", "warning", 24, "class Timer has no doc comment" },
		{ "undocumented", "warning", 34, "class cursorImpl has no doc comment" },
		{ "undocumented", "warning", 70, "function main.cursor has no doc comment" },
		{ "undocumented", "warning", 75, "function main.plain has no doc comment" },
		{ "undocumented", "warning", 29, "method Timer:elapsed has no doc comment" },
		{ "undocumented", "warning", 37, "method cursorImpl:advance has no doc comment" },
		{ "undocumented", "warning", 27, "type Timer has no doc comment" },
	}, "reportUndocumented warnings")

	local externalRoot = util.joinPath(t.fixtures, "external")
	local externalGraph, externalDiag = t.buildGraph(externalRoot, "main.luau", {
		aliases = { lute = "https://lute.test/lute", std = "https://lute.test/std", pkg = true },
	})
	local externalDoc = model.assemble(externalGraph, externalDiag, { entryPoints = { "main.luau" } })
	local externalMod = byId(externalDoc.modules, "main.luau")
	local fsMount = byName(externalMod.reexports, "fs")
	local readFile = byName(externalMod.reexports, "readFile")
	local plainMount = byName(externalMod.reexports, "plain")
	t.eq({
		#externalDiag.list,
		fsMount.targetModule,
		fsMount.url,
		fsMount.targetId,
		fsMount.doc,
		readFile.targetMember,
		readFile.url,
		byName(externalMod.reexports, "thing").targetModule,
		plainMount.targetModule,
		plainMount.url,
		wireSegs(byName(externalMod.members, "open").signature.returns[1].type),
		wireSegs(byName(externalMod.members, "raw").signature.returns[1].type),
	}, {
		0,
		"@lute/fs",
		"https://lute.test/lute/fs",
		nil,
		"The runtime's file system, mounted whole.",
		"readfile",
		"https://lute.test/lute/fs",
		"vendor/thing.luau",
		"@pkg/plain",
		nil,
		{ { text = "fs.File" } },
		{ { text = "plain.Blob" } },
	}, "runtime alias mounts and type references")
	t.eq(externalDoc.externals, {
		["@lute/fs"] = { url = "https://lute.test/lute/fs", alias = "lute", path = "fs" },
		["fs.File"] = { url = "https://lute.test/lute/fs", alias = "lute", path = "fs", name = "File" },
		["client.Response"] = {
			url = "https://lute.test/lute/net/client",
			alias = "lute",
			path = "net/client",
			name = "Response",
		},
		["@pkg/plain"] = { alias = "pkg", path = "plain" },
		["plain.Blob"] = { alias = "pkg", path = "plain", name = "Blob" },
	}, "externalDoc.externals map")

	t.suite("model: regressions (respelled types, passthrough typeIdIn, annotatedReturn, and tag forwarding)")

	local regDoc, regDiag = assembleInline({
		{
			id = "main.luau",
			src = table.concat({
				'local Sub = require("./Sub")',
				'local Mid = require("./Mid")',
				"export type Opts1 = Sub.Options",
				"export type Opts2 = Sub.Options",
				"--- @interface RenamedBox",
				"export type RawBox = { value: Mid.Item }",
				"--- @ignore",
				"type RenamedBox = string",
				"local M = {}",
				"M.prefixedCall = Sub.makePrefixed()",
				"M.packCall = Sub.makePack()",
				"return M",
			}, "\n"),
		},
		{
			id = "Sub.luau",
			surfaced = false,
			src = table.concat({
				'local T = require("./Mid")',
				"--- Shared options doc.",
				"--- @since 1.2.0",
				"--- @field extra boolean -- injected by tag",
				"export type Options = {",
				"\t--- Count doc.",
				"\tcount: number,",
				"}",
				"local Sub = {}",
				"function Sub.makePrefixed<T>(): T.Item",
				"\treturn nil :: any",
				"end",
				"function Sub.makePack<U...>(): (U...) -> ()",
				"\treturn nil :: any",
				"end",
				"return Sub",
			}, "\n"),
		},
		{
			id = "Mid.luau",
			src = 'return require("./Real")',
		},
		{
			id = "Real.luau",
			src = table.concat({
				"export type Item = number",
				"local Real = {}",
				"return Real",
			}, "\n"),
		},
	})
	local regMain = byId(regDoc.modules, "main.luau")
	local opts1 = byName(regMain.types, "Opts1")
	local opts2 = byName(regMain.types, "Opts2")
	local renamedBox = byName(regMain.types, "RenamedBox")
	t.eq({
		#regDiag.list,
		opts1.doc,
		opts2.doc,
		opts1.tags.since,
		opts2.tags.since,
		#opts1.fields,
		#opts2.fields,
		opts1.fields[1].doc,
		opts2.fields[1].doc,
		opts1.fields[2].name,
		opts2.fields[2].name,
		renamedBox.fields[1].type[1].id,
		byName(regMain.members, "prefixedCall").type[1].id,
		byName(regMain.members, "packCall").type,
	}, {
		0,
		"Shared options doc.",
		"Shared options doc.",
		"1.2.0",
		"1.2.0",
		2,
		2,
		"Count doc.",
		"Count doc.",
		"extra",
		"extra",
		"Real.luau#type.Item",
		"Real.luau#type.Item",
		nil,
	}, "multiple respelled aliases, passthrough typeIdIn, prefixed generic return, and genericPack return rejection")

	local ownerDoc, ownerDiag = assembleInline({
		{
			id = "owner.luau",
			src = table.concat({
				"--- @function topFloating",
				"",
				"type Shape = {",
				"\t--- Field-level doc from owner type.",
				"\t--- @param x number -- param from owner type",
				"\t--- @param ghost string -- mismatched param on owner type",
				"\trun: (x: number) -> (),",
				"}",
				"local M: Shape = {} :: any",
				"function M.run(x: number) end",
				"return M",
			}, "\n"),
		},
	})
	local ownerMod = byId(ownerDoc.modules, "owner.luau")
	local diagCodes = {}
	for _, d in ownerDiag.list do
		table.insert(diagCodes, d.code)
	end
	t.eq(
		{
			byName(ownerMod.members, "topFloating") ~= nil,
			byName(ownerMod.members, "run").doc,
			diagCodes,
		},
		{
			true,
			"Field-level doc from owner type.",
			{ "param-mismatch" },
		},
		"owner table-type field doc forwards diagnostics without false orphaned-doc-block and top placing block survives moduleDoc"
	)

	t.suite("model: .d.luau classes, companion tables, indexers, overloads, and @deprecated attributes")

	local dluauDoc, dluauDiag = assembleInline({
		{
			id = "globalTypes.d.luau",
			src = table.concat({
				"--- Global runtime definitions.",
				"",
				"--- Version string.",
				"declare  _VERSION: string",
				"",
				"@[deprecated {",
				'\tuse = "warn()",',
				'\treason = "legacy logger",',
				"}]",
				"declare  function oldLog(",
				"\tmsg: string",
				"): ()",
				"",
				"declare Vec: {",
				"\t--- Constructs a Vec.",
				"\t--- @param x -- X component",
				"\t--- @param y -- Y component",
				"\tnew: (() -> Vec) & ((x: number, y: number) -> Vec),",
				"\tzero: Vec,",
				"}",
				"",
				"--- 2D vector class.",
				"declare class Vec",
				"\tread X: number",
				"\tY: number",
				"\tcfg:",
				"\t\t| {",
				"\t\t\ta: number,",
				"\t\t}",
				"\t\t| nil",
				"\tread [number]: number",
				"\t@deprecated",
				"\tfunction Magnitude(self): number",
				"\tfunction Lerp(",
				"\t\tself,",
				"\t\tother: Vec,",
				"\t\talpha: number",
				"\t): Vec",
				"\tfunction Lerp(self, other: Vec): Vec",
				"\tfunction __add(self, other: Vec): Vec",
				"end",
			}, "\n"),
		},
		{
			id = "Quat.d.luau",
			src = table.concat({
				"declare class Quat",
				"\tfunction Rotate(self, v: Vec): Vec",
				"end",
				"--- @within Quat",
				"--- @method Inverse",
				"--- @return Quat",
			}, "\n"),
		},
	})
	local dluauMod = byId(dluauDoc.modules, "globalTypes.d.luau")
	local quatMod = byId(dluauDoc.modules, "Quat.d.luau")
	local quatPrimaryCls = byName(quatMod.classes, "Quat")
	local vecCls = byName(dluauMod.classes, "Vec")
	local vecMemberIds = {}
	for _, m in vecCls.members do
		table.insert(vecMemberIds, m.id)
		t.eq(m.__overload, nil, "__overload scratch key is stripped")
	end
	local new2 = byId(vecCls.members, "globalTypes.d.luau#fn.Vec.new:2")
	local lerp1 = byId(vecCls.members, "globalTypes.d.luau#fn.Vec.Lerp")
	local mag = byName(vecCls.members, "Magnitude")
	local oldLog = byName(dluauMod.members, "oldLog")
	t.eq(
		{
			#dluauDiag.list,
			dluauMod.name,
			dluauMod.doc,
			byName(dluauMod.members, "_VERSION").kind,
			byName(dluauMod.members, "_VERSION").doc,
			oldLog.tags.deprecated,
			vecCls.doc,
			vecCls.constructors,
			vecMemberIds,
			new2.signature.params[1].doc,
			new2.signature.params[2].doc,
			byName(vecCls.members, "X").readonly,
			byName(vecCls.members, "Y").readonly,
			byName(vecCls.members, "[number]").readonly,
			mag.tags.deprecated ~= nil,
			wireSegs(lerp1.signature.params[1].type),
			wireSegs(lerp1.signature.returns[1].type),
			byName(vecCls.members, "__add").kind,
			#quatMod.members,
			byName(quatPrimaryCls.members, "Rotate") ~= nil,
			byName(quatPrimaryCls.members, "Inverse") ~= nil,
			wireSegs(byName(quatPrimaryCls.members, "Rotate").signature.params[1].type),
		},
		{
			0,
			"globalTypes",
			"Global runtime definitions.",
			"prop",
			"Version string.",
			{ note = "legacy logger (use `warn()` instead)" },
			"2D vector class.",
			{ "globalTypes.d.luau#fn.Vec.new" },
			{
				"globalTypes.d.luau#fn.Vec.new",
				"globalTypes.d.luau#fn.Vec.new:2",
				"globalTypes.d.luau#prop.Vec.zero",
				"globalTypes.d.luau#prop.Vec.X",
				"globalTypes.d.luau#prop.Vec.Y",
				"globalTypes.d.luau#prop.Vec.cfg",
				"globalTypes.d.luau#prop.Vec.[number]",
				"globalTypes.d.luau#fn.Vec.Magnitude",
				"globalTypes.d.luau#fn.Vec.Lerp",
				"globalTypes.d.luau#fn.Vec.Lerp:2",
				"globalTypes.d.luau#fn.Vec.__add",
			},
			"X component",
			"Y component",
			true,
			false,
			true,
			true,
			{ { text = "Vec", id = "globalTypes.d.luau#class.Vec" } },
			{ { text = "Vec", id = "globalTypes.d.luau#class.Vec" } },
			"metamethod",
			0,
			true,
			true,
			{ { text = "Vec", id = "globalTypes.d.luau#class.Vec" } },
		},
		".d.luau assembly builds companion constructors, overload IDs, readonly props/indexers, cross-file ambient class links, and deprecated attributes"
	)

	local edgeDoc, edgeDiag = assembleInline({
		{
			id = "ambientEdge.d.luau",
			src = table.concat({
				"--- Companion Vec2 table doc.",
				"declare Vec2: {",
				"\tfromPolar: ((r: number, theta: number) -> Vec2) & ((r: number) -> Vec2),",
				"}",
				"",
				"--- Primary Vec2 class doc.",
				"declare class Vec2",
				"\tread [string]: number",
				"end",
				"",
				"--- @ignore",
				"declare class HiddenClass",
				"\tX: number",
				"end",
				"",
				"@[deprecated]",
				"declare function bareDep(): ()",
				"",
				"@[deprecated { reason = 'use modern path' }]",
				"declare function reasonDep(): ()",
				"",
				"@[deprecated { use = 'newCall()' }]",
				"declare function useDep(): ()",
				"",
				"--- @deprecated v1.0 -- doc tag wins",
				"@[deprecated { reason = 'attr ignored' }]",
				"declare function docWinsDep(): ()",
			}, "\n"),
		},
		{
			id = "sidecar.d.luau",
			surfaced = false,
			src = table.concat({
				"declare class SidecarVec2",
				"\t--- @within Vec2",
				"\t--- Normalized copy.",
				"\tfunction Unit(self): Vec2",
				"end",
			}, "\n"),
		},
	}, true)
	local edgeMod = byId(edgeDoc.modules, "ambientEdge.d.luau")
	local vec2Cls = byName(edgeMod.classes, "Vec2")
	local undocumentedMsgs = {}
	for _, d in edgeDiag.list do
		if d.code == "undocumented" then
			table.insert(undocumentedMsgs, d.message)
		end
	end
	t.eq(
		{
			byName(edgeMod.classes, "HiddenClass"),
			vec2Cls.doc,
			byName(vec2Cls.members, "Unit") ~= nil,
			byName(vec2Cls.members, "Unit").doc,
			byName(edgeMod.members, "bareDep").tags.deprecated,
			byName(edgeMod.members, "reasonDep").tags.deprecated,
			byName(edgeMod.members, "useDep").tags.deprecated,
			byName(edgeMod.members, "docWinsDep").tags.deprecated,
			undocumentedMsgs,
		},
		{
			nil,
			"Primary Vec2 class doc.\n\nCompanion Vec2 table doc.",
			true,
			"Normalized copy.",
			{ __record = true },
			{ note = "use modern path" },
			{ note = "Use `newCall()` instead." },
			{ version = "v1.0", note = "doc tag wins" },
			{
				"function ambientEdge.bareDep has no doc comment",
				"function ambientEdge.reasonDep has no doc comment",
				"function ambientEdge.useDep has no doc comment",
				"function ambientEdge.docWinsDep has no doc comment",
				"function Vec2.fromPolar has no doc comment",
				"property Vec2[string] has no doc comment",
			},
		},
		".d.luau model merges companion docs, honors @ignore, moves sidecar declared class members, parses @deprecated attribute variants, and formats undocumented indexers without duplicate overload warnings"
	)
end
