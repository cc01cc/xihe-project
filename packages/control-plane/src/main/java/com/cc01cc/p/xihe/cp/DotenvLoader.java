package com.cc01cc.p.xihe.cp;

import io.github.cdimascio.dotenv.Dotenv;
import io.github.cdimascio.dotenv.DotenvEntry;
import java.io.File;
import java.nio.file.Path;
import java.nio.file.Paths;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class DotenvLoader {

    private static final Logger logger = LoggerFactory.getLogger(DotenvLoader.class);
    private static final int MAX_DEPTH = 5;

    private DotenvLoader() {}

    public static void load() {
        if ("0".equals(System.getenv("XIHE_LOAD_DOTENV"))) {
            return;
        }
        Path root = findProjectRoot();
        if (root == null) {
            return;
        }
        loadFile(root, ".env");
        loadFile(root, ".env.dev");
    }

    private static void loadFile(Path root, String filename) {
        File file = root.resolve(filename).toFile();
        if (!file.exists()) {
            return;
        }
        Dotenv dotenv = Dotenv.configure()
                .directory(root.toString())
                .filename(filename)
                .load();
        for (DotenvEntry entry : dotenv.entries()) {
            String key = entry.getKey();
            if (System.getenv(key) != null) {
                continue;
            }
            if (System.getProperty(key) != null) {
                continue;
            }
            System.setProperty(key, entry.getValue());
        }
    }

    static Path findProjectRoot() {
        Path cwd = Paths.get(System.getProperty("user.dir")).toAbsolutePath().normalize();
        for (int i = 0; i < MAX_DEPTH; i++) {
            if (cwd.resolve(".env.dev").toFile().exists()) {
                return cwd;
            }
            if (cwd.resolve(".git").toFile().exists()) {
                return null;
            }
            cwd = cwd.getParent();
            if (cwd == null) {
                return null;
            }
        }
        return null;
    }
}
