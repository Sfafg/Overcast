function uid() {
	if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
	return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function formatBps(bps) {
	const value = Number.isFinite(bps) ? Math.max(0, bps) : 0;
	if (value >= 1e6) return `${(value / 1e6).toFixed(2)} Mbps`;
	if (value >= 1e3) return `${(value / 1e3).toFixed(1)} kbps`;
	return `${value.toFixed(0)} bps`;
}

function formatBytes(bytes) {
	const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
	if (value >= 1e9) return `${(value / 1e9).toFixed(2)} GB`;
	if (value >= 1e6) return `${(value / 1e6).toFixed(2)} MB`;
	if (value >= 1e3) return `${(value / 1e3).toFixed(1)} kB`;
	return `${value.toFixed(0)} B`;
}

function codecName(stats, codecId) {
	const codec = codecId ? stats.get(codecId) : null;
	if (!codec?.mimeType) return "unknown";
	return codec.mimeType.replace(/^video\//, "");
}

async function collectPeerStats(pc) {
	const stats = await pc.getStats();
	let out = null;
	let inbound = null;
	let pair = null;

	stats.forEach((report) => {
		if (report.type === "outbound-rtp" && report.kind === "video") out = report;
		if (report.type === "inbound-rtp" && report.kind === "video") inbound = report;
	});

	stats.forEach((report) => {
		if (
			report.type === "candidate-pair" &&
			report.state === "succeeded" &&
			(report.selected || report.nominated)
		) {
			pair = report;
		}
	});

	if (!pair) {
		stats.forEach((report) => {
			if (report.type === "transport" && report.selectedCandidatePairId) {
				const candidate = stats.get(report.selectedCandidatePairId);
				if (candidate) pair = candidate;
			}
		});
	}

	return { stats, out, inbound, pair };
}

function createPeer(onCandidate) {
	const pc = new RTCPeerConnection({});
	const peer = { pc, pending: [], lastStats: null };

	pc.onicecandidate = (event) => {
		if (event.candidate) onCandidate(event.candidate);
	};

	return peer;
}

const videoCodecCapabilities =
	globalThis.RTCRtpSender?.getCapabilities?.("video")?.codecs ?? [];
const videoDecodeCapabilities =
	globalThis.RTCRtpReceiver?.getCapabilities?.("video")?.codecs ?? [];
const codecPriorityStorageKey = "overcast.videoCodecPriority";

function codecFamily(codec) {
	const mimeType = codec.mimeType?.toLowerCase() ?? "";
	if (!mimeType.startsWith("video/")) return null;
	const family = mimeType.slice("video/".length);
	return ["rtx", "red", "ulpfec"].includes(family) || family.startsWith("flexfec-")
		? null
		: family;
}

function supportedVideoCodecFamilies() {
	return [
		...new Set(
			videoCodecCapabilities.map(codecFamily).filter(Boolean),
		),
	];
}

function supportedVideoDecodeFamilies() {
	return [
		...new Set(videoDecodeCapabilities.map(codecFamily).filter(Boolean)),
	];
}

function decodeOnlyVideoFamilies() {
	const encodable = new Set(supportedVideoCodecFamilies());
	return supportedVideoDecodeFamilies().filter((family) => !encodable.has(family));
}

function loadCodecPriority() {
	const supported = supportedVideoCodecFamilies();
	try {
		const saved = JSON.parse(localStorage.getItem(codecPriorityStorageKey));
		if (Array.isArray(saved)) {
			return [
				...saved.filter((family) => supported.includes(family)),
				...supported.filter((family) => !saved.includes(family)),
			];
		}
	} catch { }
	return supported;
}

function preferredVideoCodecs() {
	const prioritized = codecPriority.flatMap((family) =>
		videoCodecCapabilities.filter((codec) => codecFamily(codec) === family),
	);
	const auxiliary = videoCodecCapabilities.filter(
		(codec) => !codecFamily(codec),
	);
	return [...prioritized, ...auxiliary];
}

function applyVideoCodecPreferences(transceiver) {
	if (!transceiver?.setCodecPreferences || !videoCodecCapabilities.length) return;
	transceiver.setCodecPreferences(preferredVideoCodecs());
}

function addVideoTrack(pc, track, stream) {
	const sender = pc.addTrack(track, stream);
	const transceiver = pc
		.getTransceivers()
		.find((candidate) => candidate.sender === sender);
	applyVideoCodecPreferences(transceiver);
	return sender;
}

function codecLabel(family) {
	return (
		{ h264: "H.264", h265: "H.265 / HEVC", vp8: "VP8", vp9: "VP9", av1: "AV1" }[family] ??
		family.toUpperCase()
	);
}

let codecPriority = loadCodecPriority();

async function addRemoteCandidate(peer, candidate) {
	if (!peer.pc.remoteDescription) {
		peer.pending.push(candidate);
		return;
	}
	try {
		await peer.pc.addIceCandidate(candidate);
	} catch (err) {
		console.warn("Failed to add ICE candidate:", err);
	}
}

async function flushCandidates(peer) {
	const queued = peer.pending;
	peer.pending = [];
	for (const candidate of queued) {
		try {
			await peer.pc.addIceCandidate(candidate);
		} catch (err) {
			console.warn("Failed to add queued ICE candidate:", err);
		}
	}
}

const id = uid();

const ipStatusDisplay = document.getElementById("ipStatus");
const startStreamButton = document.getElementById("startStream");
const streamPreview = document.getElementById("streamPreview");
const ipAddressField = document.getElementById("ipAddress");
const watchStreamButton = document.getElementById("watchStream");
const refreshStreamsButton = document.getElementById("refreshStreams");
const streamDirectoryEl = document.getElementById("streamDirectory");
const hostNickField = document.getElementById("hostNick");
const hostLog = document.getElementById("hostLog");
const hostEvents = document.getElementById("hostEvents");
const watchSummary = document.getElementById("watchSummary");
const streamsContainer = document.getElementById("streams");
const toggleStreamOnlyButton = document.getElementById("toggleStreamOnly");
const exitStreamOnlyButton = document.getElementById("exitStreamOnly");
const hostFpsInput = document.getElementById("hostFps");
const hostBitrateInput = document.getElementById("hostBitrate");
const hostScaleInput = document.getElementById("hostScale");
const hostFpsValue = document.getElementById("hostFpsValue");
const hostBitrateValue = document.getElementById("hostBitrateValue");
const hostScaleValue = document.getElementById("hostScaleValue");
const codecPrioritySection = document.getElementById("codecPrioritySection");
const codecPriorityList = document.getElementById("codecPriorityList");
const codecDecodeOnlySection = document.getElementById("codecDecodeOnlySection");
const codecDecodeOnlyList = document.getElementById("codecDecodeOnlyList");

let videoSource = null;
let hostWs = null;
let hostJoinSent = false;
let wantHosting = false;
let hostNick = hostNickField.value.trim() || "Host";
let hostSettings = { fps: 60, bitrateMbps: 10, scalePercent: 100 };
let hostSettingsTimer = null;
let hostReconnectTimer = null;
let hostStatsBusy = false;
let hostEventList = [];

const hostPeers = new Map();
const knownClients = new Map();

function sendHost(data) {
	if (hostWs?.readyState === WebSocket.OPEN) {
		hostWs.send(JSON.stringify(data));
	}
}

function currentStreamInfo() {
	const track = videoSource?.getVideoTracks?.()[0];
	const settings = track?.getSettings?.() ?? {};
	return {
		width: settings.width ?? null,
		height: settings.height ?? null,
		frameRate: settings.frameRate ?? null,
		settings: { ...hostSettings },
	};
}

function appendHostEvent(text) {
	const time = new Date().toLocaleTimeString();
	hostEventList.unshift({ time, text });
	if (hostEventList.length > 80) hostEventList.pop();
	hostEvents.innerHTML = hostEventList
		.map(
			(event) =>
				`<div class="event"><time>${event.time}</time>${escapeHtml(event.text)}</div>`,
		)
		.join("");
}

function joinHost() {
	hostJoinSent = true;
	sendHost({
		type: "join",
		id,
		nick: hostNick,
		clientType: "host",
		info: currentStreamInfo(),
	});
}

function connectHost() {
	const ws = new WebSocket(`ws://${location.hostname || "localhost"}:3000`);
	hostWs = ws;

	ws.addEventListener(
		"open",
		() => {
			hostJoinSent = false;
			sendHost({ type: "myIps" });
			sendHost({ type: "listStreams" });
			if (wantHosting) joinHost();
		},
		{ once: true },
	);

	ws.addEventListener("message", (event) => {
		let msg;
		try {
			msg = JSON.parse(event.data);
		} catch {
			return;
		}
		handleHostMessage(msg).catch((err) =>
			console.warn("Host message error:", err),
		);
	});

	ws.addEventListener("close", () => {
		if (hostWs !== ws) return;
		hostJoinSent = false;
		for (const peer of hostPeers.values()) {
			try {
				peer.pc.close();
			} catch { }
		}
		hostPeers.clear();
		knownClients.clear();
		appendHostEvent("Disconnected from server");
		if (hostReconnectTimer) clearTimeout(hostReconnectTimer);
		hostReconnectTimer = setTimeout(connectHost, 1500);
	});
}

async function handleHostMessage(msg) {
	switch (msg.type) {
		case "ips":
			ipStatusDisplay.textContent = msg.ips.length
				? `Your ip addresses: ${msg.ips.join(", ")}`
				: "No external IPv4 addresses found.";
			break;

		case "streams":
			updateStreamDirectory(
				location.hostname || "localhost",
				msg.streams,
			);
			break;

		case "joined":
			hostJoinSent = true;
			hostNick = msg.nick;
			hostNickField.value = msg.nick;
			appendHostEvent(`Joined server as ${msg.nick}`);
			break;

		case "nickSet":
			hostNick = msg.nick;
			hostNickField.value = msg.nick;
			appendHostEvent(`Nick changed to ${msg.nick}`);
			break;

		case "clientJoined":
			knownClients.set(msg.id, { id: msg.id, nick: msg.nick });
			appendHostEvent(`${msg.nick} joined`);
			if (videoSource) await negotiate(msg.id);
			break;

		case "clientUpdated": {
			const client = knownClients.get(msg.id);
			if (client) {
				const previous = client.nick;
				client.nick = msg.nick;
				appendHostEvent(`${previous} is now ${msg.nick}`);
			}
			break;
		}

		case "clientLeft": {
			const client = knownClients.get(msg.id);
			if (client) appendHostEvent(`${client.nick} left`);
			knownClients.delete(msg.id);
			closeHostPeer(msg.id);
			break;
		}

		case "answer": {
			const peer = hostPeers.get(msg.from);
			if (!peer) break;
			await peer.pc.setRemoteDescription(msg.data);
			await flushCandidates(peer);
			await applyPeerSettings(msg.from);
			if (peer.renegotiateRequested) {
				peer.renegotiateRequested = false;
				await negotiate(msg.from);
			}
			break;
		}

		case "iceCandidate": {
			const peer = hostPeers.get(msg.from);
			if (peer) await addRemoteCandidate(peer, msg.data);
			break;
		}

		case "wants":
			await applyHostWants(msg.from, msg.wants, msg.nick);
			break;
	}
}

function getHostPeer(clientId) {
	const existing = hostPeers.get(clientId);
	if (existing) return existing;

	const peer = createPeer((candidate) => {
		sendHost({ type: "iceCandidate", to: clientId, data: candidate });
	});

	if (videoSource) {
		videoSource
			.getVideoTracks()
			.forEach((track) => addVideoTrack(peer.pc, track, videoSource));
	}

	peer.pc.onconnectionstatechange = () => {
		const state = peer.pc.connectionState;
		if (state === "failed") {
			appendHostEvent(`Connection with ${knownClients.get(clientId)?.nick ?? clientId} failed`);
		}
	};

	hostPeers.set(clientId, peer);
	return peer;
}

function closeHostPeer(clientId) {
	const peer = hostPeers.get(clientId);
	if (!peer) return;
	try {
		peer.pc.close();
	} catch { }
	hostPeers.delete(clientId);
}

async function negotiate(clientId) {
	const peer = getHostPeer(clientId);
	if (peer.negotiating || peer.pc.signalingState !== "stable") {
		peer.renegotiateRequested = true;
		return;
	}
	peer.negotiating = true;
	try {
		const offer = await peer.pc.createOffer();
		await peer.pc.setLocalDescription(offer);
		sendHost({
			type: "offer",
			to: clientId,
			data: peer.pc.localDescription,
			info: currentStreamInfo(),
		});
		await applyPeerSettings(clientId);
	} catch (err) {
		console.warn("Failed to create offer:", err);
	} finally {
		peer.negotiating = false;
	}
}

function firstNumber(...values) {
	for (const value of values) {
		if (Number.isFinite(value)) return value;
	}
	return undefined;
}

function effectiveSettingsFor(clientId) {
	const wants = knownClients.get(clientId)?.wants ?? {};
	const wantedFps = firstNumber(wants.fps, wants.maxFramerate);
	const wantedBitrate = firstNumber(
		wants.bitrateMbps,
		Number.isFinite(wants.maxBitrateKbps)
			? wants.maxBitrateKbps / 1000
			: undefined,
	);
	const wantedScale = firstNumber(wants.scalePercent);

	return {
		fps: Math.max(1, Math.min(hostSettings.fps, wantedFps ?? hostSettings.fps)),
		bitrateMbps: Math.max(
			0.1,
			Math.min(
				hostSettings.bitrateMbps,
				wantedBitrate ?? hostSettings.bitrateMbps,
			),
		),
		scalePercent: Math.max(
			1,
			Math.min(
				100,
				hostSettings.scalePercent,
				wantedScale ?? hostSettings.scalePercent,
			),
		),
	};
}

async function applyPeerSettings(clientId) {
	const peer = hostPeers.get(clientId);
	if (!peer) return;
	const sender = peer.pc
		.getSenders()
		.find((candidate) => candidate.track?.kind === "video");
	if (!sender) return;

	const effective = effectiveSettingsFor(clientId);

	try {
		const params = sender.getParameters();
		if (!params.encodings?.length) params.encodings = [{}];
		const encoding = params.encodings[0];

		encoding.maxFramerate = Math.round(effective.fps);
		encoding.maxBitrate = Math.round(effective.bitrateMbps * 1_000_000);
		encoding.scaleResolutionDownBy = Math.max(
			1,
			100 / effective.scalePercent,
		);

		await sender.setParameters(params);
	} catch (err) {
		console.warn("Failed to apply broadcast settings:", err);
	}
}

function updateHostSettings() {
	hostSettings = {
		fps: Number(hostFpsInput.value),
		bitrateMbps: Number(hostBitrateInput.value),
		scalePercent: Number(hostScaleInput.value),
	};
	hostFpsValue.textContent = `${hostSettings.fps} fps`;
	hostBitrateValue.textContent = `${hostSettings.bitrateMbps} Mbps`;
	hostScaleValue.textContent = `${hostSettings.scalePercent}%`;

	if (hostSettingsTimer) clearTimeout(hostSettingsTimer);
	hostSettingsTimer = setTimeout(() => {
		hostSettingsTimer = null;
		for (const clientId of hostPeers.keys()) {
			applyPeerSettings(clientId).catch((err) =>
				console.warn("Failed to update broadcast settings:", err),
			);
		}

		if (hostJoinSent) {
			sendHost({ type: "streamInfo", info: currentStreamInfo() });
		}
	}, 120);
}

function renderCodecPriority() {
	const decodeOnly = decodeOnlyVideoFamilies();
	codecPrioritySection.hidden = !codecPriority.length && !decodeOnly.length;
	codecPriorityList.replaceChildren();
	codecPriority.forEach((family, index) => {
		const item = document.createElement("li");
		const handle = document.createElement("span");
		const name = document.createElement("span");
		const capabilities = document.createElement("span");
		item.dataset.index = index;
		handle.className = "codec-drag-handle";
		handle.draggable = true;
		handle.title = "Drag to reorder";
		handle.setAttribute("aria-hidden", "true");
		name.className = "codec-name";
		name.textContent = codecLabel(family);
		capabilities.className = "codec-directions";
		capabilities.append(
			createCodecCapability("Encode", true),
			createCodecCapability(
				"Decode",
				supportedVideoDecodeFamilies().includes(family),
			),
		);
		item.append(handle, name, capabilities);
		codecPriorityList.append(item);
	});

	codecDecodeOnlySection.hidden = !decodeOnly.length;
	codecDecodeOnlyList.replaceChildren();
	for (const family of decodeOnly) {
		const item = document.createElement("li");
		const name = document.createElement("span");
		const capabilities = document.createElement("span");
		name.className = "codec-name";
		name.textContent = codecLabel(family);
		capabilities.className = "codec-directions";
		capabilities.append(
			createCodecCapability("Encode", false),
			createCodecCapability("Decode", true),
		);
		item.append(name, capabilities);
		codecDecodeOnlyList.append(item);
	}
}

function createCodecCapability(direction, available) {
	const status = document.createElement("span");
	status.className = available ? "codec-capability available" : "codec-capability";
	status.textContent = available ? direction : `No ${direction.toLowerCase()}`;
	status.setAttribute(
		"aria-label",
		`${direction} ${available ? "available" : "unavailable"}`,
	);
	return status;
}

function reorderCodecPriority(fromIndex, toIndex) {
	if (
		fromIndex === toIndex ||
		fromIndex < 0 ||
		toIndex < 0 ||
		fromIndex >= codecPriority.length ||
		toIndex >= codecPriority.length
	) {
		return;
	}
	const [family] = codecPriority.splice(fromIndex, 1);
	codecPriority.splice(toIndex, 0, family);
	try {
		localStorage.setItem(codecPriorityStorageKey, JSON.stringify(codecPriority));
	} catch { }
	renderCodecPriority();

	for (const [clientId, peer] of hostPeers) {
		for (const transceiver of peer.pc.getTransceivers()) {
			if (transceiver.sender.track?.kind === "video") {
				applyVideoCodecPreferences(transceiver);
			}
		}
		negotiate(clientId);
	}
}

async function applyHostWants(clientId, wants, nick) {
	const client = knownClients.get(clientId);
	if (client) client.wants = wants ?? {};

	await applyPeerSettings(clientId);
	const effective = effectiveSettingsFor(clientId);
	appendHostEvent(
		`${nick ?? "Viewer"} requested ${wants?.fps ?? 60} fps, ${wants?.bitrateMbps ?? 10
		} Mbps, ${wants?.scalePercent ?? 100}% -> effective ${effective.fps} fps, ${effective.bitrateMbps
		} Mbps, ${effective.scalePercent}%`,
	);
}

async function shareScreen() {
	const source = await navigator.mediaDevices.getDisplayMedia({
		video: true,
		audio: false,
	});

	if (videoSource) {
		videoSource.getTracks().forEach((track) => track.stop());
	}

	videoSource = source;
	streamPreview.srcObject = source;

	const track = source.getVideoTracks()[0];
	if (track) {
		track.addEventListener("ended", () => {
			appendHostEvent("Screen share ended");
		});
	}

	for (const [clientId, peer] of hostPeers) {
		const sender = peer.pc
			.getSenders()
			.find((candidate) => candidate.track?.kind === "video");

		if (sender && track) {
			await sender.replaceTrack(track);
			await applyPeerSettings(clientId);
		} else if (track) {
			addVideoTrack(peer.pc, track, source);
			await negotiate(clientId);
		}
	}

	sendHost({ type: "streamInfo", info: currentStreamInfo() });
}

async function ensureHostJoined() {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (hostWs?.readyState === WebSocket.OPEN) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	if (!hostJoinSent) joinHost();
}

async function startStream() {
	if (!videoSource) await shareScreen();
	if (!videoSource) return;

	wantHosting = true;
	await ensureHostJoined();
	sendHost({ type: "streamInfo", info: currentStreamInfo() });

	for (const clientId of knownClients.keys()) {
		await negotiate(clientId);
	}

	appendHostEvent("Stream started");
}

function renderHostLog(rows, totals) {
	const summary = `<div class="summary">Viewers: ${knownClients.size} | outgoing ${formatBps(
		totals.out,
	)} | incoming ${formatBps(totals.in)} | sent ${formatBytes(
		totals.sent,
	)} | received ${formatBytes(totals.received)}</div>`;

	const viewerRows = rows
		.map(
			(row) => `<div class="viewer-row">
				<span title="${escapeHtml(row.client.nick)}"><span class="label">Nick</span>${escapeHtml(
				row.client.nick,
			)}</span>
				<span><span class="label">Codec</span>${escapeHtml(row.codec)}</span>
				<span><span class="label">Resolution</span>${escapeHtml(row.dims)}</span>
				<span><span class="label">FPS</span>${escapeHtml(String(row.fps))}</span>
				<span><span class="label">Out / In</span>${formatBps(row.out)} / ${formatBps(
				row.in,
			)}</span>
				<span><span class="label">Effective</span>${row.effective.fps} fps / ${row.effective.bitrateMbps
				} Mbps / ${row.effective.scalePercent}%</span>
			</div>`,
		)
		.join("");

	hostLog.innerHTML =
		summary +
		(viewerRows ||
			`<div class="muted">No viewers connected yet. Start a stream and keep this window open.</div>`);
}

async function updateHostLog() {
	if (hostStatsBusy) return;
	hostStatsBusy = true;

	try {
		const now = performance.now();
		let totalOut = 0;
		let totalIn = 0;
		let totalSent = 0;
		let totalReceived = 0;
		const rows = [];

		for (const client of knownClients.values()) {
			const peer = hostPeers.get(client.id);
			let outBps = 0;
			let inBps = 0;
			let sent = 0;
			let received = 0;
			let codec = "unknown";
			let fps = "unknown";
			let dims = "unknown";

			if (peer) {
				try {
					const { stats, out, pair } = await collectPeerStats(peer.pc);
					if (out) {
						sent = out.bytesSent ?? 0;
						codec = codecName(stats, out.codecId);
						fps = out.framesPerSecond
							? Math.round(out.framesPerSecond)
							: "unknown";
						dims =
							out.frameWidth && out.frameHeight
								? `${out.frameWidth}x${out.frameHeight}`
								: "unknown";
					}
					received = pair?.bytesReceived ?? 0;

					if (peer.lastStats) {
						const seconds = (now - peer.lastStats.ts) / 1000;
						if (seconds > 0) {
							outBps = Math.max(0, ((sent - peer.lastStats.sent) * 8) / seconds);
							inBps = Math.max(
								0,
								((received - peer.lastStats.received) * 8) / seconds,
							);
						}
					}
					peer.lastStats = { ts: now, sent, received };
				} catch (err) {
					console.warn("Host stats error:", err);
				}
			}

			totalOut += outBps;
			totalIn += inBps;
			totalSent += sent;
			totalReceived += received;
			rows.push({
				client,
				out: outBps,
				in: inBps,
				codec,
				fps,
				dims,
				effective: effectiveSettingsFor(client.id),
			});
		}

		renderHostLog(rows, {
			out: totalOut,
			in: totalIn,
			sent: totalSent,
			received: totalReceived,
		});
	} finally {
		hostStatsBusy = false;
	}
}

const viewerConnections = new Map();
const streamDirectory = new Map();
let viewerCounter = 0;
let viewerStatsBusy = false;
let watchTotals = { in: 0, out: 0, received: 0, sent: 0 };

function sendViewer(conn, data) {
	if (conn.ws?.readyState === WebSocket.OPEN) {
		conn.ws.send(JSON.stringify(data));
	}
}

function viewerStreamKey(conn, hostId) {
	return `${conn.key}:${hostId}`;
}

function targetAddress(targetIp) {
	const target = String(targetIp ?? "").trim();
	if (!target) return "";
	const hostPart = target
		.replace(/^wss?:\/\//i, "")
		.replace(/^https?:\/\//i, "")
		.replace(/\/.*$/, "");
	return hostPart.includes(":") ? hostPart : `${hostPart}:3000`;
}

function streamResolutionLabel(info) {
	const width = info?.width;
	const height = info?.height;
	if (!width || !height) return "resolution unknown";
	const fps = info?.settings?.fps ?? info?.frameRate;
	return `${width}x${height}${fps ? ` · ${Math.round(fps)} fps` : ""}`;
}

function updateStreamDirectory(server, streams) {
	const target = targetAddress(server);
	if (!target) return;

	if (!Array.isArray(streams) || !streams.length) {
		streamDirectory.delete(target);
	} else {
		const entries = new Map();
		for (const stream of streams) {
			if (!stream?.id) continue;
			entries.set(String(stream.id), {
				...stream,
				id: String(stream.id),
				server: target,
			});
		}
		if (entries.size) streamDirectory.set(target, entries);
		else streamDirectory.delete(target);
	}

	renderStreamDirectory();
}

function isWatchingStream(server, hostId) {
	for (const conn of viewerConnections.values()) {
		if (conn.target !== server) continue;
		if (!conn.watchHostId || conn.watchHostId === hostId) return true;
	}
	return false;
}

function renderStreamDirectory() {
	const entries = [...streamDirectory.values()]
		.flatMap((streams) => [...streams.values()])
		.sort((a, b) => (a.nick ?? "").localeCompare(b.nick ?? ""));

	if (!entries.length) {
		streamDirectoryEl.innerHTML =
			'<div class="muted">No live streams found. Start a broadcast or enter an IP and click Watch Stream.</div>';
		return;
	}

	streamDirectoryEl.innerHTML = entries
		.map((stream) => {
			const watching = isWatchingStream(stream.server, stream.id);
			const ips = stream.ips?.length
				? stream.ips.join(", ")
				: stream.server;
			return `<div class="directory-row">
				<div class="directory-main">
					<strong>${escapeHtml(stream.nick || "Host")}</strong>
					<span class="directory-ip">${escapeHtml(ips)}</span>
					<span class="muted">${escapeHtml(streamResolutionLabel(stream.info))}</span>
				</div>
				<button type="button" class="secondary" data-watch-server="${escapeHtml(
				stream.server,
			)}" data-watch-host="${escapeHtml(stream.id)}" ${watching ? "disabled" : ""
				}>${watching ? "Watching" : "Watch"}</button>
			</div>`;
		})
		.join("");
}

function requestStreamLists() {
	sendHost({ type: "listStreams" });
	for (const conn of viewerConnections.values()) {
		sendViewer(conn, { type: "listStreams" });
	}
}

function createViewerConnection(targetIp, watchHostId = null) {
	const address = targetAddress(targetIp);
	if (!address) {
		watchSummary.textContent = "Enter an IP address to watch a stream.";
		return null;
	}

	const key = `conn-${++viewerCounter}`;
	const ws = new WebSocket(`ws://${address}`);
	const conn = {
		key,
		target: address,
		ws,
		nick: `Viewer ${uid().slice(0, 4)}`,
		watchHostId: watchHostId ? String(watchHostId) : null,
		selfId: `viewer-${uid()}`,
		streams: new Map(),
		hostMeta: new Map(),
		pendingCandidates: new Map(),
	};

	viewerConnections.set(key, conn);
	renderStreamDirectory();

	ws.addEventListener("open", () => {
		sendViewer(conn, {
			type: "join",
			id: conn.selfId,
			nick: conn.nick,
			clientType: "client",
			watchHostId: conn.watchHostId,
		});
		sendViewer(conn, { type: "listStreams" });
	});

	ws.addEventListener("message", (event) => {
		let msg;
		try {
			msg = JSON.parse(event.data);
		} catch {
			return;
		}
		handleViewerMessage(conn, msg).catch((err) =>
			console.warn("Viewer message error:", err),
		);
	});

	ws.addEventListener("close", () => {
		for (const stream of [...conn.streams.values()]) {
			removeViewerStream(stream);
		}
		viewerConnections.delete(key);
		renderStreamDirectory();
		updateWatchSummary();
	});

	updateWatchSummary();
	return conn;
}

async function handleViewerMessage(conn, msg) {
	switch (msg.type) {
		case "joined":
			conn.selfId = msg.id;
			conn.nick = msg.nick;
			break;

		case "nickSet":
			conn.nick = msg.nick;
			break;

		case "streams":
			updateStreamDirectory(conn.target, msg.streams);
			break;

		case "hostJoined":
			conn.hostMeta.set(msg.id, {
				nick: msg.nick,
				info: msg.info ?? null,
			});
			break;

		case "hostUpdated": {
			const meta = conn.hostMeta.get(msg.id);
			if (meta) meta.nick = msg.nick;
			const stream = conn.streams.get(viewerStreamKey(conn, msg.id));
			if (stream) stream.tile.nickEl.textContent = msg.nick;
			break;
		}

		case "streamInfo": {
			const meta = conn.hostMeta.get(msg.from) ?? {
				nick: msg.nick,
				info: null,
			};
			meta.info = msg.info ?? null;
			conn.hostMeta.set(msg.from, meta);
			const stream = conn.streams.get(viewerStreamKey(conn, msg.from));
			if (stream) {
				stream.info = msg.info ?? null;
				updateTileResolution(stream);
			}
			break;
		}

		case "hostLeft": {
			const stream = conn.streams.get(viewerStreamKey(conn, msg.id));
			if (stream) removeViewerStream(stream);
			conn.hostMeta.delete(msg.id);
			break;
		}

		case "offer":
			await handleViewerOffer(conn, msg);
			break;

		case "iceCandidate": {
			const stream = conn.streams.get(viewerStreamKey(conn, msg.from));
			if (stream) {
				await addRemoteCandidate(stream, msg.data);
			} else {
				const pending = conn.pendingCandidates.get(msg.from) ?? [];
				pending.push(msg.data);
				conn.pendingCandidates.set(msg.from, pending);
			}
			break;
		}
	}
}

async function handleViewerOffer(conn, msg) {
	const meta = conn.hostMeta.get(msg.from);
	const nick = msg.nick ?? meta?.nick ?? "Host";
	const info = msg.info ?? meta?.info ?? null;

	if (meta) {
		meta.nick = nick;
		meta.info = info;
	} else {
		conn.hostMeta.set(msg.from, { nick, info });
	}

	const stream = getViewerStream(conn, msg.from, nick, info);
	await stream.pc.setRemoteDescription(msg.data);
	await flushCandidates(stream);

	const pending = conn.pendingCandidates.get(msg.from);
	if (pending) {
		conn.pendingCandidates.delete(msg.from);
		for (const candidate of pending) {
			await addRemoteCandidate(stream, candidate);
		}
	}

	const answer = await stream.pc.createAnswer();
	await stream.pc.setLocalDescription(answer);
	sendViewer(conn, {
		type: "answer",
		to: msg.from,
		data: stream.pc.localDescription,
	});
}

function buildStreamTile(key, nick) {
	const el = document.createElement("article");
	el.className = "stream-tile";
	el.dataset.key = key;
	el.innerHTML = `<header class="tile-head">
			<span class="tile-nick"></span>
			<span class="tile-codec">codec unknown</span>
			<span class="tile-stats">waiting for stream</span>
			<button type="button" class="tile-close" title="Close stream">x</button>
		</header>
		<video autoplay playsinline></video>
		<div class="wants">
			<label>FPS <span class="wants-fps-value">60 fps</span><input class="wants-fps" type="range" min="5" max="180" step="1" value="60"></label>
			<label>Bitrate <span class="wants-bitrate-value">10 Mbps</span><input class="wants-bitrate" type="range" min="1" max="100" step="1" value="10"></label>
			<label>Resolution <span class="wants-scale-value">100%</span><input class="wants-scale" type="range" min="10" max="100" step="5" value="100"></label>
			<div class="tile-res">Resolution: 100% of native (native unknown)</div>
		</div>
		<div class="resize-handle"></div>`;

	el.querySelector(".tile-nick").textContent = nick;
	streamsContainer.append(el);

	return {
		el,
		video: el.querySelector("video"),
		nickEl: el.querySelector(".tile-nick"),
		codecEl: el.querySelector(".tile-codec"),
		statsEl: el.querySelector(".tile-stats"),
		resEl: el.querySelector(".tile-res"),
		closeBtn: el.querySelector(".tile-close"),
		fpsInput: el.querySelector(".wants-fps"),
		bitrateInput: el.querySelector(".wants-bitrate"),
		scaleInput: el.querySelector(".wants-scale"),
		fpsValue: el.querySelector(".wants-fps-value"),
		bitrateValue: el.querySelector(".wants-bitrate-value"),
		scaleValue: el.querySelector(".wants-scale-value"),
		resizeHandle: el.querySelector(".resize-handle"),
	};
}

function getViewerStream(conn, hostId, nick, info) {
	const key = viewerStreamKey(conn, hostId);
	const existing = conn.streams.get(key);
	if (existing) {
		existing.nick = nick;
		existing.tile.nickEl.textContent = nick;
		if (info) {
			existing.info = info;
			updateTileResolution(existing);
		}
		return existing;
	}

	const pc = new RTCPeerConnection({});
	const tile = buildStreamTile(key, nick);
	const stream = {
		key,
		conn,
		hostId,
		pc,
		tile,
		info,
		nick,
		pending: [],
		lastStats: null,
		wantsTimer: null,
	};

	conn.streams.set(key, stream);

	pc.onicecandidate = (event) => {
		if (event.candidate) {
			sendViewer(conn, {
				type: "iceCandidate",
				to: hostId,
				data: event.candidate,
			});
		}
	};

	pc.ontrack = (event) => {
		tile.video.srcObject =
			event.streams[0] ?? new MediaStream([event.track]);
		tile.video.play?.().catch(() => { });
	};

	pc.onconnectionstatechange = () => {
		if (pc.connectionState === "failed") {
			tile.statsEl.textContent = "connection failed";
		}
	};

	bindStreamTile(stream);
	updateTileResolution(stream);
	updateWatchSummary();
	if (streamOnly) layoutStreamOnly();
	return stream;
}

function bindStreamTile(stream) {
	const { tile } = stream;

	tile.closeBtn.addEventListener("click", (event) => {
		event.stopPropagation();
		removeViewerStream(stream);
	});

	tile.fpsInput.addEventListener("input", () => {
		updateWantsLabels(stream);
		scheduleViewerWants(stream);
	});

	tile.bitrateInput.addEventListener("input", () => {
		updateWantsLabels(stream);
		scheduleViewerWants(stream);
	});

	tile.scaleInput.addEventListener("input", () => {
		updateWantsLabels(stream);
		updateTileResolution(stream);
		scheduleViewerWants(stream);
	});

	makeTileDraggable(stream);
}

function updateWantsLabels(stream) {
	stream.tile.fpsValue.textContent = `${Number(stream.tile.fpsInput.value)} fps`;
	stream.tile.bitrateValue.textContent = `${Number(
		stream.tile.bitrateInput.value,
	)} Mbps`;
	stream.tile.scaleValue.textContent = `${Number(
		stream.tile.scaleInput.value,
	)}%`;
}

function scheduleViewerWants(stream) {
	if (stream.wantsTimer) clearTimeout(stream.wantsTimer);
	stream.wantsTimer = setTimeout(() => {
		stream.wantsTimer = null;
		applyViewerWants(stream);
	}, 150);
}

function removeViewerStream(stream) {
	stream.conn.streams.delete(stream.key);
	try {
		stream.pc.close();
	} catch { }
	stream.tile.el.remove();
	updateWatchSummary();
}

function applyViewerWants(stream) {
	const fps = Number(stream.tile.fpsInput.value);
	const bitrateMbps = Number(stream.tile.bitrateInput.value);
	const scalePercent = Number(stream.tile.scaleInput.value);
	const wants = {
		fps: Math.min(180, Math.max(1, fps)),
		bitrateMbps: Math.min(100, Math.max(1, bitrateMbps)),
		scalePercent: Math.min(100, Math.max(10, scalePercent)),
	};

	sendViewer(stream.conn, {
		type: "wants",
		to: stream.hostId,
		wants,
	});

	updateTileResolution(stream);
	stream.tile.statsEl.textContent = "settings requested";
}

function updateTileResolution(stream, actualDims) {
	const viewerScale = Math.min(
		100,
		Math.max(1, Number(stream.tile.scaleInput.value) || 100),
	);
	const info = stream.info;
	const hostScale = Math.min(
		100,
		Math.max(1, Number(info?.settings?.scalePercent) || 100),
	);
	const effectiveScale = Math.min(hostScale, viewerScale);
	let text = `Resolution: ${effectiveScale}% of native (native unknown)`;

	if (info?.width && info?.height) {
		const width = Math.round((info.width * effectiveScale) / 100);
		const height = Math.round((info.height * effectiveScale) / 100);
		text = `Resolution: ${width}x${height} (${effectiveScale}% of native ${info.width}x${info.height} | host ${hostScale}% / you ${viewerScale}%)`;
	}

	if (actualDims && actualDims !== "unknown") {
		text += ` | receiving ${actualDims}`;
	}

	stream.tile.resEl.textContent = text;
}

async function updateViewerStats() {
	if (viewerStatsBusy) return;
	viewerStatsBusy = true;

	try {
		const now = performance.now();
		let totalIn = 0;
		let totalOut = 0;
		let totalReceived = 0;
		let totalSent = 0;

		for (const conn of viewerConnections.values()) {
			for (const stream of conn.streams.values()) {
				if (stream.pc.connectionState === "closed") continue;

				let inBps = 0;
				let outBps = 0;
				let received = 0;
				let sent = 0;
				let codec = "unknown";
				let fps = "unknown";
				let dims = "unknown";

				try {
					const { stats, out, inbound, pair } = await collectPeerStats(
						stream.pc,
					);

					if (inbound) {
						received = inbound.bytesReceived ?? 0;
						codec = codecName(stats, inbound.codecId);
						fps = inbound.framesPerSecond
							? Math.round(inbound.framesPerSecond)
							: "unknown";
						dims =
							inbound.frameWidth && inbound.frameHeight
								? `${inbound.frameWidth}x${inbound.frameHeight}`
								: "unknown";
					}

					sent = pair?.bytesSent ?? out?.bytesSent ?? 0;

					if (stream.lastStats) {
						const seconds = (now - stream.lastStats.ts) / 1000;
						if (seconds > 0) {
							inBps = Math.max(
								0,
								((received - stream.lastStats.received) * 8) / seconds,
							);
							outBps = Math.max(
								0,
								((sent - stream.lastStats.sent) * 8) / seconds,
							);
						}
					}
					stream.lastStats = { ts: now, received, sent };
				} catch (err) {
					console.warn("Viewer stats error:", err);
				}

				totalIn += inBps;
				totalOut += outBps;
				totalReceived += received;
				totalSent += sent;

				stream.tile.codecEl.textContent = codec;
				const parts = [];
				if (inBps) parts.push(`in ${formatBps(inBps)}`);
				if (outBps) parts.push(`out ${formatBps(outBps)}`);
				if (dims !== "unknown") parts.push(dims);
				if (fps !== "unknown") parts.push(`${fps} fps`);
				stream.tile.statsEl.textContent = parts.length
					? parts.join(" | ")
					: "connected";
				updateTileResolution(stream, dims);
			}
		}

		watchTotals = {
			in: totalIn,
			out: totalOut,
			received: totalReceived,
			sent: totalSent,
		};
		updateWatchSummary();
	} finally {
		viewerStatsBusy = false;
	}
}

function updateWatchSummary() {
	let count = 0;
	for (const conn of viewerConnections.values()) count += conn.streams.size;

	if (count === 0) {
		watchSummary.textContent = "Not watching any streams.";
		return;
	}

	watchSummary.textContent = `Streams: ${count} | incoming ${formatBps(
		watchTotals.in,
	)} | outgoing ${formatBps(watchTotals.out)} | received ${formatBytes(
		watchTotals.received,
	)} | sent ${formatBytes(watchTotals.sent)}`;
}

let streamOnly = false;

function allStreams() {
	const list = [];
	for (const conn of viewerConnections.values()) {
		for (const stream of conn.streams.values()) list.push(stream);
	}
	return list;
}

function layoutStreamOnly() {
	const streams = allStreams();
	if (!streams.length) return;

	const gap = 14;
	const viewportWidth = window.innerWidth;
	const viewportHeight = window.innerHeight;
	const columns = Math.max(
		1,
		Math.floor((viewportWidth - gap) / (460 + gap)),
	);
	const rowsNeeded = Math.ceil(streams.length / columns);
	const width = Math.max(
		260,
		Math.floor((viewportWidth - gap * (columns + 1)) / columns),
	);
	const maxHeight = Math.floor(
		(viewportHeight - gap * (rowsNeeded + 1)) / rowsNeeded,
	);
	const height = Math.max(140, Math.min(Math.round((width * 9) / 16), maxHeight));

	for (let index = 0; index < streams.length; index += 1) {
		const column = index % columns;
		const row = Math.floor(index / columns);
		const left = gap + column * (width + gap);
		const top = gap + row * (height + gap);
		const el = streams[index].tile.el;
		el.style.left = `${left}px`;
		el.style.top = `${top}px`;
		el.style.width = `${width}px`;
		el.style.height = `${height}px`;
	}
}

function clearStreamOnlyLayout() {
	for (const stream of allStreams()) {
		const style = stream.tile.el.style;
		style.removeProperty("left");
		style.removeProperty("top");
		style.removeProperty("width");
		style.removeProperty("height");
	}
}

function setStreamOnly(enabled) {
	streamOnly = enabled;
	document.body.classList.toggle("stream-only", enabled);
	if (enabled) {
		layoutStreamOnly();
	} else {
		clearStreamOnlyLayout();
	}
}

function makeTileDraggable(stream) {
	const el = stream.tile.el;
	let drag = null;

	el.addEventListener("pointerdown", (event) => {
		if (!streamOnly) return;
		if (event.target.closest("button, input, select, label, .resize-handle")) {
			return;
		}
		const rect = el.getBoundingClientRect();
		drag = {
			mode: "move",
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			left: rect.left,
			top: rect.top,
			width: rect.width,
			height: rect.height,
		};
		el.setPointerCapture(event.pointerId);
		event.preventDefault();
	});

	stream.tile.resizeHandle.addEventListener("pointerdown", (event) => {
		if (!streamOnly) return;
		const rect = el.getBoundingClientRect();
		drag = {
			mode: "resize",
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			left: rect.left,
			top: rect.top,
			width: rect.width,
			height: rect.height,
		};
		stream.tile.resizeHandle.setPointerCapture(event.pointerId);
		event.stopPropagation();
		event.preventDefault();
	});

	el.addEventListener("pointermove", (event) => {
		if (!drag || event.pointerId !== drag.pointerId) return;
		const dx = event.clientX - drag.startX;
		const dy = event.clientY - drag.startY;

		if (drag.mode === "move") {
			const left = Math.min(
				Math.max(0, window.innerWidth - 60),
				Math.max(-drag.width + 60, drag.left + dx),
			);
			const top = Math.min(
				Math.max(0, window.innerHeight - 40),
				Math.max(0, drag.top + dy),
			);
			el.style.left = `${left}px`;
			el.style.top = `${top}px`;
		} else {
			const width = Math.max(
				220,
				Math.min(window.innerWidth - drag.left, drag.width + dx),
			);
			const height = Math.max(
				124,
				Math.min(window.innerHeight - drag.top, drag.height + dy),
			);
			el.style.width = `${width}px`;
			el.style.height = `${height}px`;
		}
	});

	const endDrag = (event) => {
		if (drag && event.pointerId === drag.pointerId) drag = null;
	};
	el.addEventListener("pointerup", endDrag);
	el.addEventListener("pointercancel", endDrag);
}

for (const input of [hostFpsInput, hostBitrateInput, hostScaleInput]) {
	input.addEventListener("input", updateHostSettings);
}

codecPriorityList.addEventListener("dragstart", (event) => {
	const item = event.target.closest("li[data-index]");
	if (!item || !event.target.closest(".codec-drag-handle")) {
		event.preventDefault();
		return;
	}
	event.dataTransfer.effectAllowed = "move";
	event.dataTransfer.setData("text/plain", item.dataset.index);
	item.classList.add("is-dragging");
});

codecPriorityList.addEventListener("dragover", (event) => {
	const item = event.target.closest("li[data-index]");
	if (!item) return;
	event.preventDefault();
	event.dataTransfer.dropEffect = "move";
	codecPriorityList
		.querySelectorAll(".drop-target")
		.forEach((candidate) => candidate.classList.remove("drop-target"));
	item.classList.add("drop-target");
});

codecPriorityList.addEventListener("drop", (event) => {
	const item = event.target.closest("li[data-index]");
	if (!item) return;
	event.preventDefault();
	const fromIndex = Number(event.dataTransfer.getData("text/plain"));
	reorderCodecPriority(fromIndex, Number(item.dataset.index));
});

codecPriorityList.addEventListener("dragend", () => {
	codecPriorityList
		.querySelectorAll(".is-dragging, .drop-target")
		.forEach((item) => item.classList.remove("is-dragging", "drop-target"));
});

startStreamButton.addEventListener("click", () => {
	startStream().catch((err) => console.error(err));
});

watchStreamButton.addEventListener("click", () => {
	createViewerConnection(ipAddressField.value);
});

refreshStreamsButton.addEventListener("click", requestStreamLists);

streamDirectoryEl.addEventListener("click", (event) => {
	const button = event.target.closest("button[data-watch-server]");
	if (!button) return;
	createViewerConnection(
		button.dataset.watchServer,
		button.dataset.watchHost,
	);
});

toggleStreamOnlyButton.addEventListener("click", () => {
	setStreamOnly(true);
});

exitStreamOnlyButton.addEventListener("click", () => {
	setStreamOnly(false);
});

hostNickField.addEventListener("change", () => {
	const value = hostNickField.value.trim();
	if (!value) {
		hostNickField.value = hostNick;
		return;
	}
	hostNick = value;
	if (hostJoinSent) sendHost({ type: "setNick", nick: value });
});

document.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && streamOnly) setStreamOnly(false);
});

window.addEventListener("resize", () => {
	if (streamOnly) layoutStreamOnly();
});

updateHostSettings();
renderCodecPriority();
connectHost();
setInterval(() => {
	updateHostLog().catch((err) => console.warn("Host log error:", err));
}, 1000);
setInterval(() => {
	updateViewerStats().catch((err) => console.warn("Viewer stats error:", err));
}, 1000);
