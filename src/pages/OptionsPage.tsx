import { useState, useMemo, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import TagInput from "../components/TagInput";
import Tooltip from "../components/Tooltip";
import ConfirmDialog from "../components/ConfirmDialog";
import {
    type SheetData,
    isImageColumn,
    isUrl,
    getNonImageHeaders,
} from "../utils/csv";

interface OptionsPageProps {
    sheets: SheetData[];
    fileName: string;
    onNewSheet: () => void;
    onBack: () => void;
}

type Stage = "options" | "downloading" | "done";

interface DownloadTask {
    url: string;
    dest_path: string;
    file_name: string;
}

interface DownloadResult {
    success: boolean;
    file_name: string;
    task_index: number;
    error: string | null;
}

export default function OptionsPage({
    sheets,
    fileName,
    onNewSheet,
    onBack,
}: OptionsPageProps) {
    const [selectedSheet, setSelectedSheet] = useState(0);
    const [subfolderTags, setSubfolderTags] = useState<string[]>([]);
    const [renameTags, setRenameTags] = useState<string[]>([]);
    const [downloadPath, setDownloadPath] = useState("");
    const [defaultPath, setDefaultPath] = useState("");
    const [stage, setStage] = useState<Stage>("options");
    const [showConfirm, setShowConfirm] = useState(false);
    const [pathError, setPathError] = useState("");
    const [results, setResults] = useState<DownloadResult[]>([]);
    const [pendingTasks, setPendingTasks] = useState<DownloadTask[]>([]);
    const [progress, setProgress] = useState({ completed: 0, total: 0 });
    const [wasCancelled, setWasCancelled] = useState(false);
    const unlistenRef = useRef<(() => void) | null>(null);

    const sheet = sheets[selectedSheet];
    const headers = sheet?.headers || [];

    // Fetch default export path on mount
    useEffect(() => {
        invoke<string>("get_default_export_path")
            .then((p) => {
                setDefaultPath(p);
            })
            .catch(() => {});
    }, []);

    // The effective path used for download (user input or default)
    const effectivePath = downloadPath.trim() || defaultPath;

    // Non-image headers for tag suggestions
    const tagSuggestions = useMemo(
        () => getNonImageHeaders(headers, sheet?.rows || []),
        [headers, sheet?.rows],
    );

    // Count total images to download
    const imageCount = useMemo(() => {
        if (!sheet) return 0;
        let count = 0;
        const imageColIndices = headers
            .map((h, i) => (isImageColumn(h) ? i : -1))
            .filter((i) => i >= 0);

        for (const row of sheet.rows) {
            for (const colIdx of imageColIndices) {
                if (row[colIdx] && isUrl(row[colIdx])) {
                    count++;
                }
            }
        }
        return count;
    }, [sheet, headers]);

    // Build example subfolder name from first data row
    const exampleSubfolder = useMemo(() => {
        if (!sheet || sheet.rows.length === 0) return null;
        if (subfolderTags.length === 0) return "row1";
        const row = sheet.rows[0];
        const parts = subfolderTags.map((tag) => {
            const idx = headers.findIndex(
                (h) => h.toLowerCase() === tag.toLowerCase(),
            );
            return idx >= 0 && row[idx] ? row[idx].trim() : tag;
        });
        return sanitizeName(parts.join("_"), 70);
    }, [subfolderTags, sheet, headers]);

    // Build example rename from first data row
    const exampleRename = useMemo(() => {
        if (renameTags.length === 0 || !sheet || sheet.rows.length === 0)
            return null;
        const row = sheet.rows[0];
        const parts = renameTags.map((tag) => {
            const idx = headers.findIndex(
                (h) => h.toLowerCase() === tag.toLowerCase(),
            );
            return idx >= 0 && row[idx] ? row[idx].trim() : tag;
        });
        return `${sanitizeFileName(parts.join("_"), "_Img1", 70)}.jpg`;
    }, [renameTags, sheet, headers]);

    // Listen for download progress events
    useEffect(() => {
        if (stage !== "downloading") return;
        let cancelled = false;
        listen<{ completed: number; total: number }>(
            "download-progress",
            (event) => {
                if (!cancelled) {
                    setProgress(event.payload);
                }
            },
        ).then((unlisten) => {
            unlistenRef.current = unlisten;
        });
        return () => {
            cancelled = true;
            unlistenRef.current?.();
            unlistenRef.current = null;
        };
    }, [stage]);

    async function handlePickDir() {
        const dir = await open({ directory: true, multiple: false });
        if (dir) {
            setDownloadPath(dir as string);
            setPathError("");
        }
    }

    function handleDownloadClick() {
        if (!effectivePath) return;
        setShowConfirm(true);
    }

    async function handleConfirmDownload() {
        setShowConfirm(false);

        // Validate path first
        try {
            await invoke("validate_download_path", { path: effectivePath });
        } catch (err) {
            setPathError(err instanceof Error ? err.message : String(err));
            return;
        }

        setWasCancelled(false);
        setStage("downloading");
        setProgress({ completed: 0, total: 0 });

        try {
            const builtTasks: DownloadTask[] = [];
            const imageColIndices = headers
                .map((h, i) => (isImageColumn(h) ? i : -1))
                .filter((i) => i >= 0);

            // Tracks the next imgNum per (destPath, renamePrefix) pair so that
            // rows sharing the same folder+prefix never produce duplicate filenames.
            const imgCounters = new Map<string, number>();

            for (let rowIdx = 0; rowIdx < sheet.rows.length; rowIdx++) {
                const row = sheet.rows[rowIdx];
                // Build subfolder path
                let destPath = effectivePath.replace(/\\/g, "/");
                if (subfolderTags.length > 0) {
                    const subfolderParts = subfolderTags.map((tag) => {
                        const idx = headers.findIndex(
                            (h) =>
                                h.toLowerCase() === tag.toLowerCase(),
                        );
                        return idx >= 0 && row[idx]
                            ? row[idx].trim()
                            : tag;
                    });
                    const subfolderName = sanitizeName(
                        subfolderParts.join("_"),
                        70,
                    );
                    destPath = `${destPath}/${subfolderName}`;
                } else {
                    destPath = `${destPath}/row${rowIdx + 1}`;
                }

                const renameParts = renameTags.map((tag) => {
                    const idx = headers.findIndex(
                        (h) => h.toLowerCase() === tag.toLowerCase(),
                    );
                    return idx >= 0 && row[idx] ? row[idx].trim() : tag;
                });
                const renamePrefix = renameParts.join("_");

                const counterKey = `${destPath}||${renamePrefix}`;
                let imgNum = imgCounters.get(counterKey) ?? 1;

                for (const colIdx of imageColIndices) {
                    const url = row[colIdx]?.trim();
                    if (!url || !isUrl(url)) continue;

                    const normalizedUrl = url.startsWith("www.")
                        ? `https://${url}`
                        : url;
                    const suffix = `_Img${imgNum}`;
                    const fName = renamePrefix
                        ? sanitizeFileName(
                              renamePrefix,
                              suffix,
                              70,
                          )
                        : `Img${imgNum}`;

                    builtTasks.push({
                        url: normalizedUrl,
                        dest_path: destPath,
                        file_name: fName,
                    });
                    imgNum++;
                }

                imgCounters.set(counterKey, imgNum);
            }

            await runDownload(builtTasks);
        } catch (err) {
            console.error("Download error:", err);
            setResults([
                {
                    success: false,
                    file_name: "Error",
                    task_index: 0,
                    error: err instanceof Error ? err.message : String(err),
                },
            ]);
            setStage("done");
        }
    }

    async function runDownload(tasksToRun: DownloadTask[]) {
        setPendingTasks(tasksToRun);
        setProgress({ completed: 0, total: tasksToRun.length });
        const downloadResults = await invoke<DownloadResult[]>(
            "download_images",
            { tasks: tasksToRun },
        );
        setResults(downloadResults);
        setStage("done");
    }

    async function handleRetry() {
        const failedTasks = results
            .filter((r) => !r.success)
            .map((r) => pendingTasks[r.task_index]);
        setWasCancelled(false);
        setStage("downloading");
        setResults([]);
        await runDownload(failedTasks);
    }

    async function handleCancel() {
        setWasCancelled(true);
        await invoke("cancel_download");
        // Don't change stage here — let the running download_images invoke
        // finish (it will break out of the loop) and transition to 'done'
    }

    function handleBackToOptions() {
        setStage("options");
        setResults([]);
        setWasCancelled(false);
    }

    if (stage === "downloading") {
        return (
            <div className="flex-1 flex flex-col items-center justify-center gap-6">
                <div className="flex flex-col items-center gap-4">
                    <div className="spinner" />
                    <p className="text-sm text-gray-500 font-medium">
                        Downloading images...
                    </p>
                    <p className="text-2xl font-bold text-gray-800">
                        {progress.completed}
                        <span className="text-gray-400">/{progress.total}</span>
                    </p>
                </div>
                <button
                    className="btn btn-secondary mt-4"
                    onClick={handleCancel}
                >
                    Cancel
                </button>
            </div>
        );
    }

    if (stage === "done") {
        const succeeded = results.filter((r) => r.success).length;
        const failed = results.filter((r) => !r.success).length;

        return (
            <div className="flex-1 flex flex-col items-center justify-center gap-6 px-8">
                <div className="text-center">
                    {wasCancelled ? (
                        /* Red X icon for cancelled */
                        <svg
                            width="56"
                            height="56"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="#e74c3c"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="mx-auto mb-3"
                        >
                            <circle cx="12" cy="12" r="10" />
                            <line x1="15" y1="9" x2="9" y2="15" />
                            <line x1="9" y1="9" x2="15" y2="15" />
                        </svg>
                    ) : (
                        /* Green check for completed */
                        <svg
                            width="56"
                            height="56"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke={
                                failed === results.length
                                    ? "#e74c3c"
                                    : "#2ecc71"
                            }
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="mx-auto mb-3"
                        >
                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                            <polyline points="22 4 12 14.01 9 11.01" />
                        </svg>
                    )}
                    <p className="text-lg font-semibold text-gray-800">
                        {wasCancelled
                            ? "Download Cancelled"
                            : "Download Complete"}
                    </p>
                    <p className="text-sm text-gray-500 mt-1">
                        {succeeded} succeeded
                        {failed > 0 ? `, ${failed} failed` : ""}
                        {wasCancelled &&
                            `, ${progress.total - succeeded - failed} skipped`}
                    </p>
                </div>

                {failed > 0 && (
                    <div className="w-full max-w-md max-h-32 overflow-y-auto bg-red-50 rounded-xl p-3 text-xs text-red-600">
                        {results
                            .filter((r) => !r.success)
                            .map((r, i) => (
                                <p key={i}>
                                    - {r.file_name} [{r.error}]
                                </p>
                            ))}
                    </div>
                )}

                <div className="flex gap-3">
                    <button
                        className="shrink-0 w-[40px] h-[40px] flex items-center justify-center rounded-xl border-2 border-[#8a9d78] text-[#8a9d78] hover:bg-[rgba(138,157,120,0.08)] transition-colors cursor-pointer"
                        onClick={handleBackToOptions}
                        title="Back to options"
                    >
                        <svg
                            width="20"
                            height="20"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <polyline points="15 18 9 12 15 6" />
                        </svg>
                    </button>
                    {failed > 0 && (
                        <button className="btn btn-secondary" onClick={handleRetry}>
                            Retry failed ({failed})
                        </button>
                    )}
                    <button className="btn btn-primary" onClick={onNewSheet}>
                        New Sheet
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="flex-1 flex flex-col items-center justify-center px-8 py-6 overflow-y-auto">
            {showConfirm && (
                <ConfirmDialog
                    message={`Are you sure you want to download ${imageCount} images?`}
                    onConfirm={handleConfirmDownload}
                    onCancel={() => setShowConfirm(false)}
                />
            )}

            {pathError && (
                <ConfirmDialog
                    message={pathError}
                    onConfirm={() => setPathError("")}
                    onCancel={() => setPathError("")}
                    singleButton
                />
            )}

            <div className="w-full max-w-md flex flex-col gap-5">
                {/* Header with back button */}
                <div className="flex items-center">
                    <button
                        className="shrink-0 w-[36px] h-[36px] flex items-center justify-center rounded-lg hover:bg-gray-100 transition-colors"
                        onClick={onBack}
                        title="Go back"
                    >
                        <svg
                            width="20"
                            height="20"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="#666"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <polyline points="15 18 9 12 15 6" />
                        </svg>
                    </button>
                    <div className="flex-1 text-center pr-[36px]">
                        <h2 className="text-lg font-bold text-gray-800">
                            Download Options
                        </h2>
                        <p className="text-xs text-gray-400 mt-0.5">
                            {fileName}
                        </p>
                    </div>
                </div>

                {/* Sheet Tab */}
                {sheets.length > 1 && (
                    <div>
                        <label className="block text-xs text-gray-500 font-medium mb-1.5 ml-1">
                            Sheet Tab
                        </label>
                        <div className="relative">
                            <select
                                value={selectedSheet}
                                onChange={(e) => {
                                    setSelectedSheet(Number(e.target.value));
                                    setSubfolderTags([]);
                                    setRenameTags([]);
                                }}
                                className="w-full px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm outline-none appearance-none cursor-pointer focus:border-[#8a9d78] transition-colors"
                            >
                                {sheets.map((s, i) => (
                                    <option key={i} value={i}>
                                        {s.name}
                                    </option>
                                ))}
                            </select>
                            <svg
                                className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none"
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="#999"
                                strokeWidth="2"
                            >
                                <polyline points="6 9 12 15 18 9" />
                            </svg>
                        </div>
                    </div>
                )}

                {/* Subfolder Tags */}
                <div>
                    <label className="flex items-center text-xs text-gray-500 font-medium mb-1.5 ml-1">
                        Subfolder Tags
                        <Tooltip
                            content={
                                <>
                                    <p className="font-semibold mb-1">
                                        Subfolder naming
                                    </p>
                                    <p>
                                        Choose columns whose values will be
                                        joined with "_" to name the subfolder
                                        for each row. If none are selected,
                                        rows are numbered (row1, row2, ...).
                                        Spaces are replaced with -.
                                    </p>
                                    {exampleSubfolder && (
                                        <p className="mt-1.5 font-mono text-[11px] bg-[#1e2423] rounded px-1.5 py-0.5 break-all">
                                            .../{exampleSubfolder}/
                                        </p>
                                    )}
                                </>
                            }
                        />
                    </label>
                    <TagInput
                        tags={subfolderTags}
                        onChange={setSubfolderTags}
                        suggestions={tagSuggestions}
                        placeholder="e.g. Brand, ID, Vendor"
                        maxTags={3}
                    />
                </div>

                {/* Rename Tags */}
                <div>
                    <label className="flex items-center text-xs text-gray-500 font-medium mb-1.5 ml-1">
                        Rename Tags
                        <Tooltip
                            content={
                                <>
                                    <p className="font-semibold mb-1">
                                        Image renaming
                                    </p>
                                    <p>
                                        Choose columns whose values will be
                                        joined with "_" to rename each
                                        downloaded image, followed by _Img1,
                                        _Img2, etc. Spaces are replaced with -.
                                    </p>
                                    {exampleRename && (
                                        <p className="mt-1.5 font-mono text-[11px] bg-[#1e2423] rounded px-1.5 py-0.5 break-all">
                                            {exampleRename}
                                        </p>
                                    )}
                                </>
                            }
                        />
                    </label>
                    <TagInput
                        tags={renameTags}
                        onChange={setRenameTags}
                        suggestions={tagSuggestions}
                        placeholder="e.g. ID, Brand"
                        maxTags={3}
                    />
                </div>

                {/* Download Path */}
                <div>
                    <label className="block text-xs text-gray-500 font-medium mb-1.5 ml-1">
                        Download Path
                    </label>
                    <div className="flex gap-2">
                        <button
                            className="shrink-0 w-[44px] h-[44px] flex items-center justify-center bg-white border border-gray-200 rounded-xl hover:border-[#8a9d78] transition-colors cursor-pointer"
                            onClick={handlePickDir}
                            title="Choose folder"
                        >
                            <svg
                                width="18"
                                height="18"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="#666"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                            </svg>
                        </button>
                        <input
                            type="text"
                            value={downloadPath}
                            onChange={(e) => {
                                setDownloadPath(e.target.value);
                                setPathError("");
                            }}
                            placeholder={defaultPath || "Select a folder..."}
                            className="flex-1 px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm outline-none transition-colors focus:border-[#8a9d78]"
                        />
                    </div>
                </div>

                {/* Summary */}
                <div className="bg-white rounded-xl border border-gray-100 p-3 text-center text-sm text-gray-500">
                    <strong className="text-gray-700">{imageCount}</strong>{" "}
                    images found across{" "}
                    <strong className="text-gray-700">
                        {sheet.rows.length}
                    </strong>{" "}
                    rows
                </div>

                {/* Download Button */}
                <button
                    className="btn btn-primary w-full"
                    disabled={!effectivePath || imageCount === 0}
                    onClick={handleDownloadClick}
                >
                    Download
                </button>
            </div>
        </div>
    );
}

/** Strip invalid filesystem characters and truncate to maxLen. Spaces become -. */
function sanitizeName(name: string, maxLen: number): string {
    let clean = name.replace(/ /g, "-");
    // biome-ignore lint: simple regex replace
    clean = clean.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
    // Collapse runs of underscores and dashes
    clean = clean.replace(/_+/g, "_").replace(/^_|_$/g, "");
    clean = clean.replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (clean.length > maxLen) {
        clean = clean.slice(0, maxLen);
    }
    return clean || "unnamed";
}

/**
 * Build a safe filename: sanitize the prefix, then append suffix (_Img1 etc).
 * Truncates the prefix so prefix+suffix stays within maxLen (excluding extension).
 * Spaces become -.
 */
function sanitizeFileName(
    prefix: string,
    suffix: string,
    maxLen: number,
): string {
    let clean = prefix.replace(/ /g, "-");
    // biome-ignore lint: simple regex replace
    clean = clean.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
    clean = clean.replace(/_+/g, "_").replace(/^_|_$/g, "");
    clean = clean.replace(/-+/g, "-").replace(/^-|-$/g, "");
    const maxPrefix = maxLen - suffix.length;
    if (maxPrefix > 0 && clean.length > maxPrefix) {
        clean = clean.slice(0, maxPrefix);
    }
    return (clean + suffix) || `unnamed${suffix}`;
}
