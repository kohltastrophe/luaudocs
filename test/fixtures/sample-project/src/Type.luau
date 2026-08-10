--- Shared aliases, and the only module that names Roblox classes: the `New<>`
--- arms below are what `linkRobloxTypes` resolves against, so engine linking is
--- covered in one place instead of leaking into every other fixture module.

export type Function = (...any) -> ...any
export type Dict<T> = { [T]: any }
export type Set<T> = { [T]: boolean }
export type Symbol = { type: "Symbol" }

--- Maps a class name to a constructor for that class.
export type New<Name, Class> = (Name) -> (Class & Dict<any>) -> Class

--- One arm per resolvable form: a string-literal class name, and the `string`
--- fallback whose class is named as a plain identifier.
export type Constructor = New<"Frame", Frame> & New<string, Instance>

return nil
