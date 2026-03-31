import { useState, useRef, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { readTextFile } from "@tauri-apps/plugin-fs";
import Spinner from "../components/Spinner";
import ConfirmDialog from "../components/ConfirmDialog";
import { parseCSV, parseTSV, parseFile, type SheetData } from "../utils/csv";

interface LandingPageProps {
    onNext: (sheets: SheetData[], fileName: string) => void;
}

export default function LandingPage({ onNext }: LandingPageProps) {
    const [file, setFile] = useState<File | null>(null);
    const [droppedPath, setDroppedPath] = useState<string | null>(null);
    const [droppedName, setDroppedName] = useState("");
    const [dragOver, setDragOver] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    // Google auth state
    const [isGoogleAuthed, setIsGoogleAuthed] = useState(false);
    const [googleLoading, setGoogleLoading] = useState(false);
    const [googleUrl, setGoogleUrl] = useState("");
    const [sheetNames, setSheetNames] = useState<string[]>([]);
    const [selectedSheetName, setSelectedSheetName] = useState("");
    const [sheetNamesLoading, setSheetNamesLoading] = useState(false);
    const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

    const fileInputRef = useRef<HTMLInputElement>(null);

    const hasFile = !!file || !!droppedPath;
    const hasGoogleSheet =
        isGoogleAuthed &&
        googleUrl.trim().length > 0 &&
        selectedSheetName.length > 0;
    const canProceed = hasFile || hasGoogleSheet;

    // Check Google auth on mount
    useEffect(() => {
        invoke<boolean>("check_google_auth")
            .then(setIsGoogleAuthed)
            .catch(() => {});
    }, []);

    // Listen for Tauri drag-drop events (files from OS)
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        getCurrentWebviewWindow()
            .onDragDropEvent((event) => {
                if (event.payload.type === "over") {
                    setDragOver(true);
                } else if (event.payload.type === "leave") {
                    setDragOver(false);
                } else if (event.payload.type === "drop") {
                    setDragOver(false);
                    const paths = event.payload.paths;
                    if (paths && paths.length > 0) {
                        const filePath = paths[0];
                        const ext = filePath.toLowerCase().split(".").pop();
                        if (ext !== "csv" && ext !== "tsv") {
                            setError("Please select a CSV or TSV file");
                            return;
                        }
                        setError("");
                        setFile(null);
                        setDroppedPath(filePath);
                        setDroppedName(
                            filePath.split(/[\\/]/).pop() || filePath,
                        );
                        setGoogleUrl("");
                        setSheetNames([]);
                        setSelectedSheetName("");
                    }
                }
            })
            .then((fn) => {
                unlisten = fn;
            });
        return () => {
            unlisten?.();
        };
    }, []);

    // Fetch sheet names when Google URL changes
    useEffect(() => {
        if (!isGoogleAuthed || !googleUrl.trim()) {
            setSheetNames([]);
            setSelectedSheetName("");
            return;
        }
        const timeout = setTimeout(async () => {
            setSheetNamesLoading(true);
            setError("");
            try {
                const names = await invoke<string[]>("fetch_sheet_names", {
                    spreadsheetId: googleUrl.trim(),
                });
                setSheetNames(names);
                setSelectedSheetName("");
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.includes("404") || msg.includes("NOT_FOUND")) {
                    setError("Could not find a spreadsheet at that URL/ID");
                } else if (msg.includes("403") || msg.includes("PERMISSION_DENIED")) {
                    setError("You don't have permission to access this spreadsheet");
                } else if (msg.includes("400") || msg.includes("INVALID")) {
                    setError("Invalid spreadsheet URL or ID");
                } else {
                    setError("Could not load spreadsheet. Check the URL/ID and try again");
                }
                setSheetNames([]);
            } finally {
                setSheetNamesLoading(false);
            }
        }, 500);
        return () => clearTimeout(timeout);
    }, [googleUrl, isGoogleAuthed]);

    const handleFile = useCallback((f: File) => {
        const ext = f.name.toLowerCase().split(".").pop();
        if (ext !== "csv" && ext !== "tsv") {
            setError("Please select a CSV or TSV file");
            return;
        }
        setError("");
        setFile(f);
        setDroppedPath(null);
        setDroppedName("");
        setGoogleUrl("");
        setSheetNames([]);
        setSelectedSheetName("");
    }, []);

    const handleFileSelect = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
        },
        [handleFile],
    );

    async function handleGoogleLogin() {
        setGoogleLoading(true);
        setError("");
        try {
            await invoke<boolean>("google_login");
            setIsGoogleAuthed(true);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setGoogleLoading(false);
        }
    }

    async function handleGoogleLogout() {
        setShowLogoutConfirm(false);
        try {
            await invoke("google_logout");
            setIsGoogleAuthed(false);
            setGoogleUrl("");
            setSheetNames([]);
            setSelectedSheetName("");
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    async function handleNext() {
        if (hasGoogleSheet) {
            setLoading(true);
            setError("");
            try {
                const data = await invoke<{
                    headers: string[];
                    rows: string[][];
                }>("fetch_sheet_data", {
                    spreadsheetId: googleUrl.trim(),
                    sheetName: selectedSheetName,
                });
                const sheets: SheetData[] = [
                    {
                        name: selectedSheetName,
                        headers: data.headers,
                        rows: data.rows,
                    },
                ];
                onNext(sheets, `Google Sheet - ${selectedSheetName}`);
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                setLoading(false);
            }
            return;
        }

        // Handle Tauri-dropped file (read from path)
        if (droppedPath) {
            setLoading(true);
            setError("");
            try {
                const content = await readTextFile(droppedPath);
                const ext = droppedPath.toLowerCase().split(".").pop();
                const sheets =
                    ext === "tsv" ? parseTSV(content) : parseCSV(content);
                onNext(sheets, droppedName);
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                setLoading(false);
            }
            return;
        }

        // Handle browser-picked file
        if (!file) return;
        setLoading(true);
        setError("");
        try {
            const sheets = await parseFile(file);
            onNext(sheets, file.name);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }

    if (loading) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <Spinner label="Loading spreadsheet..." />
            </div>
        );
    }

    const displayFileName = file?.name || droppedName;

    return (
        <div className="flex-1 flex flex-col items-center justify-center px-8 py-10 gap-6">
            {showLogoutConfirm && (
                <ConfirmDialog
                    message="Are you sure you want to logout from Google?"
                    onConfirm={handleGoogleLogout}
                    onCancel={() => setShowLogoutConfirm(false)}
                />
            )}

            <h1 className="text-xl font-bold text-gray-800">ImgFlow</h1>
            <p className="text-sm text-gray-500 -mt-3">
                Import your spreadsheet to get started
            </p>

            {/* Drop zone */}
            <div
                className={`drop-zone w-full max-w-md flex flex-col items-center justify-center gap-3 py-12 px-6 ${
                    dragOver ? "drag-over" : ""
                } ${hasFile ? "has-file" : ""}`}
                onClick={() => fileInputRef.current?.click()}
            >
                {hasFile ? (
                    <>
                        <svg
                            width="40"
                            height="40"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="#2ecc71"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                            <polyline points="22 4 12 14.01 9 11.01" />
                        </svg>
                        <span className="text-sm font-medium text-gray-700">
                            {displayFileName}
                        </span>
                        <span className="text-xs text-gray-400">
                            Click or drag to replace
                        </span>
                    </>
                ) : (
                    <>
                        <svg
                            width="40"
                            height="40"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="#999"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                        <span className="text-sm font-medium text-gray-500">
                            Drop CSV / TSV here
                        </span>
                        <span className="text-xs text-gray-400">
                            Click to browse
                        </span>
                    </>
                )}
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,.tsv"
                    className="hidden"
                    onChange={handleFileSelect}
                />
            </div>

            {/* Divider */}
            <div className="flex items-center gap-3 w-full max-w-md">
                <div className="flex-1 h-px bg-gray-200" />
                <span className="text-xs text-gray-400 font-medium">OR</span>
                <div className="flex-1 h-px bg-gray-200" />
            </div>

            {/* Google Sheets section */}
            <div className="w-full max-w-md">
                <label className="block text-xs text-gray-500 font-medium mb-1.5 ml-1">
                    Google Sheets URL / ID
                </label>
                <div className="flex gap-2">
                    {/* Login / Logout button */}
                    <button
                        className={`shrink-0 w-[44px] h-[44px] flex items-center justify-center rounded-xl border transition-colors cursor-pointer ${
                            isGoogleAuthed
                                ? "bg-red-50 border-red-200 hover:border-red-400"
                                : "bg-white border-gray-200 hover:border-[#8a9d78]"
                        }`}
                        onClick={(e) => {
                            e.preventDefault();
                            if (isGoogleAuthed) {
                                setShowLogoutConfirm(true);
                            } else {
                                handleGoogleLogin();
                            }
                        }}
                        disabled={googleLoading}
                        title={
                            isGoogleAuthed
                                ? "Logout from Google"
                                : "Login with Google"
                        }
                    >
                        {googleLoading ? (
                            <div className="w-5 h-5 border-2 border-gray-300 border-t-[#8a9d78] rounded-full animate-spin" />
                        ) : isGoogleAuthed ? (
                            /* Logout icon */
                            <svg
                                width="18"
                                height="18"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="#e74c3c"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                                <polyline points="16 17 21 12 16 7" />
                                <line x1="21" y1="12" x2="9" y2="12" />
                            </svg>
                        ) : (
                            /* Login icon */
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
                                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                                <polyline points="10 17 15 12 10 7" />
                                <line x1="15" y1="12" x2="3" y2="12" />
                            </svg>
                        )}
                    </button>

                    <input
                        type="text"
                        placeholder={
                            isGoogleAuthed
                                ? "Paste a Google Sheets URL or Spreadsheet ID"
                                : "Login with Google to use Google Sheets"
                        }
                        value={googleUrl}
                        onChange={(e) => {
                            setGoogleUrl(e.target.value);
                            if (e.target.value.trim()) {
                                setFile(null);
                                setDroppedPath(null);
                                setDroppedName("");
                            }
                            setError("");
                        }}
                        disabled={!isGoogleAuthed}
                        className={`flex-1 px-4 py-2.5 border rounded-xl text-sm outline-none transition-colors ${
                            isGoogleAuthed
                                ? "bg-white border-gray-200 focus:border-[#8a9d78]"
                                : "bg-gray-100 border-gray-200 text-gray-400 cursor-not-allowed"
                        }`}
                    />
                </div>

                {/* Sheet name dropdown */}
                {sheetNamesLoading && (
                    <div className="flex items-center gap-2 mt-2 text-xs text-gray-400">
                        <div className="w-3 h-3 border-2 border-gray-300 border-t-[#8a9d78] rounded-full animate-spin" />
                        Loading sheets...
                    </div>
                )}
                {sheetNames.length > 0 && (
                    <div className="mt-2">
                        <label className="block text-xs text-gray-500 font-medium mb-1.5 ml-1">
                            Sheet Tab
                        </label>
                        <div className="relative">
                            <select
                                value={selectedSheetName}
                                onChange={(e) =>
                                    setSelectedSheetName(e.target.value)
                                }
                                className="w-full px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm outline-none appearance-none cursor-pointer focus:border-[#8a9d78] transition-colors"
                            >
                                <option value="">Select a sheet...</option>
                                {sheetNames.map((name) => (
                                    <option key={name} value={name}>
                                        {name}
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
            </div>

            {/* Error */}
            {error && (
                <p className="text-red-500 text-xs font-medium -mt-2">
                    {error}
                </p>
            )}

            {/* Next button */}
            <button
                className="btn btn-primary mt-2 w-full max-w-md"
                disabled={!canProceed}
                onClick={handleNext}
            >
                Proceed
            </button>
        </div>
    );
}
