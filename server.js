import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import os from "node:os";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static("frontend"));

const hosts = new Map();
const clients = new Map();

const streamsFile =
	process.env.OVERCAST_STREAMS_FILE ??
	resolve(os.tmpdir(), "overcast-streams.json");
const streamDb = loadStreamDb();
let streamsSaveTimer = null;

let anonymousCounter = 1;

function localIPv4s() {
	const ips = [];
	for (const list of Object.values(os.networkInterfaces())) {
		for (const net of list || []) {
			const isV4 = net.family === "IPv4" || net.family === 4;
			if (isV4 && !net.internal) ips.push(net.address);
		}
	}
	return ips;
}

function loadStreamDb() {
	if (!existsSync(streamsFile)) return new Map();
	try {
		const saved = JSON.parse(readFileSync(streamsFile, "utf8"));
		const entries = Array.isArray(saved) ? saved : [];
		return new Map(
			entries.map((entry) => [entry.id, { ...entry, live: false }]),
		);
	} catch (err) {
		console.warn("Could not load stream database:", err);
		return new Map();
	}
}

function persistStreams() {
	if (streamsSaveTimer) clearTimeout(streamsSaveTimer);
	streamsSaveTimer = setTimeout(() => {
		streamsSaveTimer = null;
		try {
			writeFileSync(
				streamsFile,
				JSON.stringify([...streamDb.values()], null, 2),
			);
		} catch (err) {
			console.warn("Could not save stream database:", err);
		}
	}, 200);
}

function publicStreams() {
	return [...streamDb.values()]
		.filter((stream) => stream.live)
		.map((stream) => ({
			id: stream.id,
			nick: stream.nick,
			ips: stream.ips ?? [],
			info: stream.info ?? null,
			updatedAt: stream.updatedAt ?? null,
		}));
}

function broadcastStreams() {
	const message = { type: "streams", streams: publicStreams() };
	for (const client of clients.values()) sendToTarget(client.ws, message);
	for (const host of hosts.values()) sendToTarget(host.ws, message);
}

function updateStreamEntry(host, live = true) {
	if (!host) return;
	streamDb.set(host.id, {
		id: host.id,
		nick: host.nick,
		ips: localIPv4s(),
		info: host.info ?? null,
		live,
		updatedAt: Date.now(),
	});
	persistStreams();
	broadcastStreams();
}

function removeStreamEntry(hostId) {
	const entry = streamDb.get(hostId);
	if (!entry) return;
	entry.live = false;
	entry.updatedAt = Date.now();
	persistStreams();
	broadcastStreams();
}

function sendToTarget(target, data) {
	if (target?.readyState !== WebSocket.OPEN) return;
	target.send(JSON.stringify(data));
}

function findPeer(targetId) {
	return clients.get(targetId) || hosts.get(targetId);
}

function sendToPeer(targetId, data) {
	const peer = findPeer(targetId);
	if (!peer) return false;
	sendToTarget(peer.ws, data);
	return true;
}

function normalizeNick(nick) {
	const clean = String(nick ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 32);
	return clean || `Anonymous ${anonymousCounter++}`;
}

function nickTaken(nick, excludeId) {
	const needle = nick.toLowerCase();
	for (const host of hosts.values()) {
		if (host.id !== excludeId && host.nick.toLowerCase() === needle) return true;
	}
	for (const client of clients.values()) {
		if (client.id !== excludeId && client.nick.toLowerCase() === needle) return true;
	}
	return false;
}

function uniqueNick(nick, excludeId) {
	const base = normalizeNick(nick);
	let candidate = base;
	let suffix = 2;
	while (nickTaken(candidate, excludeId)) {
		candidate = `${base} (${suffix++})`;
	}
	return candidate;
}

function announceToClients(data, exceptId) {
	for (const client of clients.values()) {
		if (client.id !== exceptId) sendToTarget(client.ws, data);
	}
}

function announceToHosts(data, exceptId) {
	for (const host of hosts.values()) {
		if (host.id !== exceptId) sendToTarget(host.ws, data);
	}
}

function announceHostJoined(host) {
	for (const client of clients.values()) {
		if (client.watchHostId && client.watchHostId !== host.id) continue;
		sendToTarget(client.ws, {
			type: "hostJoined",
			id: host.id,
			nick: host.nick,
			info: host.info,
		});
	}
}

const handlers = {
	join: (ws, msg) => {
		if (!msg.id) return;

		const type = msg.clientType === "host" ? "host" : "client";
		const existing = type === "host" ? hosts.get(msg.id) : clients.get(msg.id);
		if (existing && existing.ws !== ws) {
			try {
				existing.ws.close();
			} catch {}
		}

		ws.id = String(msg.id);
		ws.clientType = type;
		ws.nick = uniqueNick(msg.nick, ws.id);
		ws.info = type === "host" ? msg.info ?? null : null;
		ws.watchHostId =
			type === "client" && msg.watchHostId
				? String(msg.watchHostId)
				: null;

		if (type === "host") {
			const host = { ws, id: ws.id, nick: ws.nick, info: ws.info };
			hosts.set(ws.id, host);
			sendToTarget(ws, {
				type: "joined",
				id: ws.id,
				nick: ws.nick,
				clientType: "host",
			});
			for (const client of clients.values()) {
				if (client.watchHostId && client.watchHostId !== host.id) continue;
				sendToTarget(ws, {
					type: "clientJoined",
					id: client.id,
					nick: client.nick,
				});
			}
			announceHostJoined(host);
			updateStreamEntry(host);
		} else {
			const client = {
				ws,
				id: ws.id,
				nick: ws.nick,
				watchHostId: ws.watchHostId,
			};
			clients.set(ws.id, client);
			sendToTarget(ws, {
				type: "joined",
				id: ws.id,
				nick: ws.nick,
				clientType: "client",
			});
			for (const host of hosts.values()) {
				if (client.watchHostId && client.watchHostId !== host.id) continue;
				sendToTarget(ws, {
					type: "hostJoined",
					id: host.id,
					nick: host.nick,
					info: host.info,
				});
			}
			if (client.watchHostId) {
				const host = hosts.get(client.watchHostId);
				if (host) {
					sendToTarget(host.ws, {
						type: "clientJoined",
						id: client.id,
						nick: client.nick,
					});
				}
			} else {
				announceToHosts({
					type: "clientJoined",
					id: ws.id,
					nick: ws.nick,
				});
			}
		}

		sendToTarget(ws, { type: "streams", streams: publicStreams() });
	},

	setNick: (ws, msg) => {
		if (!ws.id) return;
		const record =
			ws.clientType === "host" ? hosts.get(ws.id) : clients.get(ws.id);
		if (!record) return;

		const nick = uniqueNick(msg.nick, record.id);
		record.nick = nick;
		ws.nick = nick;

		sendToTarget(ws, {
			type: "nickSet",
			id: record.id,
			nick,
			clientType: ws.clientType,
		});

		if (ws.clientType === "host") {
			announceToClients({ type: "hostUpdated", id: record.id, nick });
			updateStreamEntry(record);
		} else {
			announceToHosts({ type: "clientUpdated", id: record.id, nick });
		}
	},

	offer: (ws, msg) => {
		if (ws.clientType === "host" && msg.info) {
			const host = hosts.get(ws.id);
			if (host) {
				host.info = msg.info;
				updateStreamEntry(host);
			}
		}
		const host = ws.clientType === "host" ? hosts.get(ws.id) : null;
		sendToPeer(msg.to, {
			type: "offer",
			from: ws.id,
			nick: ws.nick,
			info: msg.info ?? host?.info ?? null,
			data: msg.data,
		});
	},

	answer: (ws, msg) => {
		sendToPeer(msg.to, {
			type: "answer",
			from: ws.id,
			nick: ws.nick,
			data: msg.data,
		});
	},

	iceCandidate: (ws, msg) => {
		sendToPeer(msg.to, {
			type: "iceCandidate",
			from: ws.id,
			data: msg.data,
		});
	},

	streamInfo: (ws, msg) => {
		if (ws.clientType !== "host") return;
		const host = hosts.get(ws.id);
		if (!host) return;
		host.info = msg.info ?? null;
		updateStreamEntry(host);
		announceToClients({
			type: "streamInfo",
			from: ws.id,
			nick: ws.nick,
			info: host.info,
		});
	},

	listStreams: (ws, _) => {
		sendToTarget(ws, { type: "streams", streams: publicStreams() });
	},

	wants: (ws, msg) => {
		if (ws.clientType !== "client") return;
		const client = clients.get(ws.id);
		const host = hosts.get(msg.to);
		if (!client || !host) return;
		sendToTarget(host.ws, {
			type: "wants",
			from: ws.id,
			nick: client.nick,
			wants: msg.wants,
		});
	},

	myIps: (ws, _) => {
		sendToTarget(ws, {
			type: "ips",
			ips: localIPv4s(),
		});
	},
};

wss.on("connection", (ws) => {
	ws.on("message", (raw) => {
		try {
			const msg = JSON.parse(raw);
			const handler = handlers[msg.type];
			if (handler) handler(ws, msg);
		} catch (err) {
			console.error("Invalid message:", err);
		}
	});

	ws.on("close", () => {
		if (ws.clientType === "host") {
			const host = hosts.get(ws.id);
			if (host?.ws !== ws) return;
			hosts.delete(ws.id);
			removeStreamEntry(ws.id);
			announceToClients({ type: "hostLeft", id: ws.id });
			return;
		}
		if (ws.clientType === "client") {
			const client = clients.get(ws.id);
			if (client?.ws !== ws) return;
			clients.delete(ws.id);
			announceToHosts({ type: "clientLeft", id: ws.id });
		}
	});
});

server.listen(3000, () => {
	console.log("Server running at http://localhost:3000");
});
