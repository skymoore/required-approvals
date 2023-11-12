default: build

.PHONY: init
init:
	npm install

.PHONY: build-deps
build-deps:
	npm i -g @vercel/ncc

.PHONY: clean
clean:
	rm -rf node_modules
	rm -rf dist

build: clean init build-deps
	ncc build src/index.js -o dist
