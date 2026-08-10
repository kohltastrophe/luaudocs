local helpers = {}

function helpers.settle()
	task.wait()
end

function helpers.fanout(remote: any)
	remote:FireAllClients(0)
end

return helpers
