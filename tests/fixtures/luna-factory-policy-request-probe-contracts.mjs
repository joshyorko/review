const OMP_SOURCE_COMMIT = "9348320cc4a30a7195d36a1f05a6c11bcb701a17";
const OMP_BINARY_PATH = "/usr/bin/omp";
const OMP_VERSION = "omp/18.5.0";
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_LABEL = /^[A-Za-z0-9._:/+-]{1,128}$/;

export function completePostAccounting(snapshot, expectedCases) {
	if (!snapshot || snapshot.activeCase !== null || snapshot.unassignedPostCount !== 0) return false;
	if (!Array.isArray(snapshot.caseWindows) || snapshot.caseWindows.length !== expectedCases.length) return false;
	const windows = new Map(snapshot.caseWindows.map((window) => [window.case, window]));
	if (windows.size !== expectedCases.length) return false;
	if (expectedCases.some((name) => !windows.get(name)?.finished)) return false;
	const assignedPosts = snapshot.caseWindows.reduce((total, window) => total + window.postCount, 0);
	return assignedPosts === snapshot.assignedPostCount && assignedPosts === snapshot.totalPostCount;
}

export function abortPostFinding(abortCalled, abortWindow, accountingComplete, markerAttributionComplete) {
	const postCount = Number.isSafeInteger(abortWindow?.postCount) ? abortWindow.postCount : null;
	return {
		zeroSendObserved: abortCalled && accountingComplete && markerAttributionComplete && postCount === 0,
		sendObserved: abortCalled && postCount !== null && postCount > 0,
		postCount,
		untaggedPostCount: abortWindow?.untaggedPostCount ?? null,
		markerMismatchPostCount: abortWindow?.markerMismatchPostCount ?? null,
	};
}

export function validateAttestationFileStat(stat) {
	if (!stat || stat.isFile !== true || stat.nlink !== 1 || !Number.isSafeInteger(stat.mode) || (stat.mode & 0o222) !== 0) {
		throw new Error("attestation must be a single-link, read-only regular file");
	}
}

export function cooperativeIdentityProblems(attestation, measured) {
	const problems = [];
	const a = attestation && typeof attestation === "object" && !Array.isArray(attestation) ? attestation : {};
	const m = measured && typeof measured === "object" ? measured : {};
	if (a.format !== "review-native-identity/v1" || typeof a.attester !== "string" || !SAFE_LABEL.test(a.attester)) problems.push("cooperative identity format/attester missing or invalid");
	if (!SHA256.test(a.imageDigest) || !SHA256.test(a.containerConfigDigest)) problems.push("cooperative image/config digest missing or malformed");
	if (typeof a.runtime !== "string" || !SAFE_LABEL.test(a.runtime)) problems.push("cooperative runtime label missing or invalid");
	if (!Number.isSafeInteger(m.effectiveUid) || !Number.isSafeInteger(a.effectiveUid) || a.effectiveUid !== m.effectiveUid) problems.push("attested effective UID differs from observed guest UID");
	if (m.ompBinaryPath !== OMP_BINARY_PATH || a.ompBinaryPath !== m.ompBinaryPath) problems.push("binary path differs from fixed /usr/bin/omp");
	if (m.ompVersion !== OMP_VERSION || a.ompVersion !== m.ompVersion) problems.push("OMP version differs from the 18.5.0 package pin");
	if (m.ompSourceCommit !== OMP_SOURCE_COMMIT || a.ompSourceCommit !== m.ompSourceCommit) problems.push("OMP source differs from the packaged SBOM pin");
	if (typeof m.ompBinarySha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.ompBinarySha256) || a.ompBinarySha256 !== m.ompBinarySha256) problems.push("binary digest differs from measured /usr/bin/omp and SBOM");
	if (typeof m.cooperativeEvidenceFileSha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.cooperativeEvidenceFileSha256)) problems.push("cooperative evidence input digest unavailable");
	return problems;
}

export function validateCooperativeIdentityInput(attestation, measured) {
	const problems = cooperativeIdentityProblems(attestation, measured);
	if (problems.length > 0) throw new Error(problems.join("; "));
	return {
		attester: attestation.attester,
		imageDigest: attestation.imageDigest,
		containerConfigDigest: attestation.containerConfigDigest,
		runtime: attestation.runtime,
		effectiveUid: attestation.effectiveUid,
		ompBinaryPath: measured.ompBinaryPath,
		ompVersion: measured.ompVersion,
		ompSourceCommit: measured.ompSourceCommit,
		ompBinarySha256: measured.ompBinarySha256,
		cooperativeEvidenceFileSha256: measured.cooperativeEvidenceFileSha256,
	};
}
