async function example(req, res, next){
	if(req.method == "POST"){
        console.log("cheese")
	}
	console.log("burger");
}

module.exports.example = example;