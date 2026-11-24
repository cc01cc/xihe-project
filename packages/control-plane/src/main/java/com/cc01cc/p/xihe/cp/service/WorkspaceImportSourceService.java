package com.cc01cc.p.xihe.cp.service;

import org.springframework.stereotype.Service;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;

/**
 * task-980: enumerates the host roots the workspace import wizard may start from.
 *
 * <p>Only real, readable roots are returned: {@link File#listRoots()} already skips
 * unmounted/nonexistent drive letters, and the readability probe drops roots the CP process
 * cannot traverse. No directory content is exposed here — the per-directory read stays on
 * the Runtime-backed {@code /workspaces/import-sources} face.</p>
 */
@Service
public class WorkspaceImportSourceService {

    public List<ImportSourceRoot> listRoots() {
        return filterRoots(File.listRoots(), WorkspaceImportSourceService::isUsableRoot);
    }

    /**
     * Seam used by {@code WorkspaceImportSourceServiceTest} to feed a fabricated
     * nonexistent drive letter and assert it never reaches the API response.
     */
    static List<ImportSourceRoot> filterRoots(File[] candidates, Predicate<Path> usable) {
        List<ImportSourceRoot> roots = new ArrayList<>();
        if (candidates == null) {
            return roots;
        }
        for (File candidate : candidates) {
            if (candidate == null) {
                continue;
            }
            Path path = candidate.toPath().toAbsolutePath();
            if (!usable.test(path)) {
                continue;
            }
            String absolute = path.toString();
            roots.add(new ImportSourceRoot(absolute, labelFor(absolute), kindFor(absolute)));
        }
        return roots;
    }

    private static boolean isUsableRoot(Path path) {
        return Files.isDirectory(path) && Files.isReadable(path);
    }

    static String labelFor(String path) {
        String trimmed = path;
        while (trimmed.length() > 1 && (trimmed.endsWith("\\") || trimmed.endsWith("/"))) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed.isEmpty() ? "/" : trimmed;
    }

    static String kindFor(String path) {
        return path.matches("^[A-Za-z]:[\\\\/]?$") ? "drive" : "root";
    }

    /** One selectable root: {@code path} is what Runtime reads, {@code label} is what the UI shows. */
    public record ImportSourceRoot(String path, String label, String kind) {
    }
}
