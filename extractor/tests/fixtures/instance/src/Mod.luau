local Parent = script.Parent
local Other = require(Parent.Other)
local Named = require(Parent:WaitForChild("Other"))

return { Other = Other, Named = Named }
