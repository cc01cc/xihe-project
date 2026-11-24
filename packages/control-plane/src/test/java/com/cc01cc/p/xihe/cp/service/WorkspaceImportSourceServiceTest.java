package com.cc01cc.p.xihe.cp.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.function.Predicate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class WorkspaceImportSourceServiceTest {

    @TempDir
    Path tempDir;

    @Test
    void fabricatedNonexistentDriveNeverReachesTheRootList() {
        File absentDrive = new File("Z:\\");
        Path usable = tempDir.toAbsolutePath();
        Predicate<Path> onlyTempDir = path -> path.equals(usable);

        List<WorkspaceImportSourceService.ImportSourceRoot> roots =
                WorkspaceImportSourceService.filterRoots(new File[]{tempDir.toFile(), absentDrive}, onlyTempDir);

        // 反证（task-980 判据①）：去掉 readable/exists 过滤后, absentDrive 会出现在结果里。
        assertEquals(1, roots.size());
        assertEquals(usable.toString(), roots.get(0).path());
        assertEquals(usable.toString(), roots.get(0).label());
        assertEquals("root", roots.get(0).kind());
    }

    @Test
    void unreachableCandidatesAreDroppedInsteadOfBeingExposed() {
        List<WorkspaceImportSourceService.ImportSourceRoot> roots =
                WorkspaceImportSourceService.filterRoots(new File[]{new File("Z:\\")}, path -> false);
        assertTrue(roots.isEmpty());
    }

    @Test
    void nullCandidateListIsAnEmptyRootList() {
        assertTrue(WorkspaceImportSourceService.filterRoots(null, path -> true).isEmpty());
    }

    @Test
    void driveRootsCarryADriveLabelAndPosixRootsKeepTheSlash() {
        assertEquals("C:", WorkspaceImportSourceService.labelFor("C:\\"));
        assertEquals("/", WorkspaceImportSourceService.labelFor("/"));
        assertEquals("drive", WorkspaceImportSourceService.kindFor("C:\\"));
        assertEquals("drive", WorkspaceImportSourceService.kindFor("C:/"));
        assertEquals("root", WorkspaceImportSourceService.kindFor("/"));
    }

    @Test
    void realHostRootsAreAlwaysReadableDirectories() {
        for (WorkspaceImportSourceService.ImportSourceRoot root : new WorkspaceImportSourceService().listRoots()) {
            Path path = Path.of(root.path());
            assertTrue(Files.isDirectory(path), root.path());
            assertTrue(Files.isReadable(path), root.path());
            assertFalse(isBlank(root.label()), root.path());
        }
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
