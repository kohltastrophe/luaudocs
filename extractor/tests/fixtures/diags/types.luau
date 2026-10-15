--- Re-spelled by main as `export type Kept = types.Kept`, so documented there.
export type Kept = { a: number }

--- Moved onto the Diags page, so documented there.
--- @within Diags
export type Moved = { c: number }

--- Reached by nothing: the module is tags-only, so this is documented nowhere.
export type Lost = { b: number }

return nil
