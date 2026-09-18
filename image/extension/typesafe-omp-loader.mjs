import typesafeExtension from "./pi-typesafe/extensions/index.js";

export default function loadTypeSafe(pi) {
	if (typeof pi.registerEntryRenderer !== "function") {
		pi.registerEntryRenderer = () => {};
	}
	return typesafeExtension(pi);
}
