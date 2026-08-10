-- Pkg is a directory holding its own default.project.json, Wire's $path names
-- a *.project.json file directly; Extra exists only in Pkg's nested tree
local Mod = require(script.Mod)
local Ext = require(script.Ext)
local Deep = require(script.Mod.Sub)
local Pkg = require(script.Pkg)
local Extra = require(script.Pkg.Extra)
local Wire = require(script.Wire)

return { Mod = Mod, Ext = Ext, Deep = Deep, Pkg = Pkg, Extra = Extra, Wire = Wire }
