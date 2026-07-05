package com.cc01cc.p.xihe.cp.files;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;
import com.cc01cc.p.xihe.cp.entity.File;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo;
import com.cc01cc.p.xihe.cp.files.dto.BatchUploadResult;
import com.cc01cc.p.xihe.cp.files.dto.UploadFailure;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

@Service
public class ChatAttachmentService {

    private static final Logger logger = LoggerFactory.getLogger(ChatAttachmentService.class);
    private static final long MAX_FILE_SIZE = 500L * 1024 * 1024;

    private static final Map<String, String> EXTENSION_TO_MIME = Map.ofEntries(
        Map.entry("png", "image/png"),
        Map.entry("jpg", "image/jpeg"),
        Map.entry("jpeg", "image/jpeg"),
        Map.entry("gif", "image/gif"),
        Map.entry("webp", "image/webp"),
        Map.entry("svg", "image/svg+xml"),
        Map.entry("bmp", "image/bmp"),
        Map.entry("pdf", "application/pdf"),
        Map.entry("doc", "application/msword"),
        Map.entry("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        Map.entry("txt", "text/plain"),
        Map.entry("md", "text/markdown"),
        Map.entry("json", "application/json"),
        Map.entry("csv", "text/csv"),
        Map.entry("xls", "application/vnd.ms-excel"),
        Map.entry("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        Map.entry("ppt", "application/vnd.ms-powerpoint"),
        Map.entry("pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        Map.entry("mp3", "audio/mpeg"),
        Map.entry("wav", "audio/wav"),
        Map.entry("m4a", "audio/mp4"),
        Map.entry("ogg", "audio/ogg"),
        Map.entry("flac", "audio/flac"),
        Map.entry("aac", "audio/aac"),
        Map.entry("mp4", "video/mp4"),
        Map.entry("webm", "video/webm"),
        Map.entry("mov", "video/quicktime"),
        Map.entry("avi", "video/x-msvideo"),
        Map.entry("mkv", "video/x-matroska")
    );

    private final String attachmentsBasePath;
    private final Set<String> allowedExtensions;
    private final FileRepository fileRepository;
    private final SessionRepository sessionRepository;
    private final WorkspaceUserRepository workspaceUserRepository;
    private final ObjectMapper objectMapper;

    public ChatAttachmentService(
            @Value("${cp.attachments-base-path:/data/xihe/attachments}") String attachmentsBasePath,
            @Value("${cp.attachments.allowed-extensions:png,jpg,jpeg,gif,webp,svg,bmp,pdf,doc,docx,txt,md,json,csv,xls,xlsx,ppt,pptx,mp3,wav,m4a,ogg,flac,aac,mp4,webm,mov,avi,mkv}") String allowedExtensionsConfig,
            FileRepository fileRepository,
            SessionRepository sessionRepository,
            WorkspaceUserRepository workspaceUserRepository,
            ObjectMapper objectMapper) {
        this.attachmentsBasePath = attachmentsBasePath;
        this.allowedExtensions = parseAllowedExtensions(allowedExtensionsConfig);
        this.fileRepository = fileRepository;
        this.sessionRepository = sessionRepository;
        this.workspaceUserRepository = workspaceUserRepository;
        this.objectMapper = objectMapper;
    }

    @Transactional
    public BatchUploadResult upload(String sessionId, List<MultipartFile> files, String userId, String workspaceId) {
        ensureSessionExists(sessionId, workspaceId, userId);
        verifyWorkspaceMembership(userId, workspaceId);

        List<AttachmentInfo> success = new ArrayList<>();
        List<UploadFailure> failed = new ArrayList<>();

        for (MultipartFile file : files) {
            String originalName = file.getOriginalFilename();
            try {
                validateUpload(file);
                String extension = getExtension(originalName).toLowerCase(Locale.ROOT);
                String mimeType = resolveMimeType(extension, file.getContentType());

                Path sessionDir = Paths.get(attachmentsBasePath, sessionId);
                Files.createDirectories(sessionDir);
                String tempId = "tmp-" + UUID.randomUUID().toString();
                Path tempPath = sessionDir.resolve(tempId);
                file.transferTo(tempPath);

                File entity = new File();
                entity.setUserId(userId);
                entity.setWorkspaceId(workspaceId);
                entity.setSessionId(sessionId);
                entity.setFilename(originalName);
                entity.setMimeType(mimeType);
                entity.setSizeBytes(file.getSize());
                entity.setStoragePath(tempPath.toString());
                entity = fileRepository.save(entity);
                String fileId = entity.getId();

                Path finalPath = sessionDir.resolve(fileId);
                Files.move(tempPath, finalPath);
                entity.setStoragePath(finalPath.toString());
                fileRepository.save(entity);

                success.add(new AttachmentInfo(fileId, originalName, mimeType, file.getSize(), "/files/" + fileId));
                logger.info("Attachment uploaded session={} fileId={} name={} size={}", sessionId, fileId, originalName, file.getSize());
            } catch (Exception e) {
                String reason = e.getMessage() != null ? e.getMessage() : "Upload failed";
                logger.warn("Attachment upload failed session={} file={} reason={}", sessionId, originalName, reason, e);
                failed.add(new UploadFailure(originalName != null ? originalName : "unknown", reason));
            }
        }

        return new BatchUploadResult(success, failed);
    }

    @Transactional
    public void delete(String sessionId, String fileId, String userId, String workspaceId) {
        verifyWorkspaceMembership(userId, workspaceId);
        File file = fileRepository.findByIdAndSessionId(fileId, sessionId)
                .orElseThrow(() -> new IllegalArgumentException("Attachment not found: " + fileId));
        deletePhysicalFile(file.getStoragePath());
        fileRepository.delete(file);
        logger.info("Attachment deleted session={} fileId={}", sessionId, fileId);
    }

    @Transactional(readOnly = true)
    public File getMetadata(String sessionId, String fileId, String userId, String workspaceId) {
        verifyWorkspaceMembership(userId, workspaceId);
        return fileRepository.findByIdAndSessionId(fileId, sessionId)
                .orElseThrow(() -> new IllegalArgumentException("Attachment not found: " + fileId));
    }

    @Transactional
    public void deleteSessionAttachments(String sessionId) {
        List<File> files = fileRepository.findBySessionId(sessionId);
        for (File file : files) {
            try {
                deletePhysicalFile(file.getStoragePath());
                fileRepository.delete(file);
                logger.info("Session attachment deleted session={} fileId={}", sessionId, file.getId());
            } catch (Exception e) {
                logger.warn("Failed to delete session attachment session={} fileId={}", sessionId, file.getId(), e);
            }
        }
        deleteDirectoryIfEmpty(Paths.get(attachmentsBasePath, sessionId));
    }

    @Transactional
    public int cleanupOrphans(Instant cutoff) {
        List<File> orphans = fileRepository.findByMessageIdIsNullAndCreatedAtBefore(cutoff);
        int count = 0;
        for (File file : orphans) {
            try {
                deletePhysicalFile(file.getStoragePath());
                fileRepository.delete(file);
                count++;
                logger.info("Orphan attachment cleaned fileId={} createdAt={}", file.getId(), file.getCreatedAt());
            } catch (Exception e) {
                logger.warn("Failed to cleanup orphan attachment fileId={}", file.getId(), e);
            }
        }
        return count;
    }

    public long getMaxFileSize() {
        return MAX_FILE_SIZE;
    }

    private void ensureSessionExists(String sessionId, String workspaceId, String userId) {
        Optional<Session> existing = sessionRepository.findById(sessionId);
        if (existing.isPresent()) {
            if (!existing.get().getWorkspaceId().equals(workspaceId)) {
                throw new IllegalArgumentException("Session does not belong to workspace");
            }
            return;
        }
        Session session = new Session(workspaceId, userId, "Attachment Upload");
        session.setId(sessionId);
        sessionRepository.save(session);
        logger.info("Session created for attachments session={} workspace={}", sessionId, workspaceId);
    }

    private void verifyWorkspaceMembership(String userId, String workspaceId) {
        if (workspaceId == null || userId == null) {
            throw new IllegalArgumentException("Workspace or user context missing");
        }
        if (!workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(workspaceId, userId).isPresent()) {
            throw new IllegalArgumentException("User is not a member of the workspace");
        }
    }

    private void validateUpload(MultipartFile file) {
        String originalName = file.getOriginalFilename();
        if (originalName == null || originalName.isBlank()) {
            throw new IllegalArgumentException("Filename is required");
        }
        if (originalName.contains("/") || originalName.contains("\\")) {
            throw new IllegalArgumentException("Filename contains path separators");
        }
        if (file.getSize() > MAX_FILE_SIZE) {
            throw new IllegalArgumentException("File exceeds maximum size of " + MAX_FILE_SIZE + " bytes");
        }
        String extension = getExtension(originalName).toLowerCase(Locale.ROOT);
        if (!allowedExtensions.contains(extension)) {
            throw new IllegalArgumentException("File type not allowed: " + extension);
        }
        String contentType = file.getContentType();
        if (contentType != null && !contentType.isBlank() && !isKnownContentType(contentType)) {
            throw new IllegalArgumentException("MIME type not allowed: " + contentType);
        }
    }

    private String getExtension(String filename) {
        int lastDot = filename.lastIndexOf('.');
        if (lastDot == -1 || lastDot == filename.length() - 1) {
            throw new IllegalArgumentException("File must have an extension");
        }
        return filename.substring(lastDot + 1);
    }

    private String resolveMimeType(String extension, String contentType) {
        String mapped = EXTENSION_TO_MIME.get(extension);
        if (contentType != null && !contentType.isBlank() && !"application/octet-stream".equals(contentType)) {
            return contentType;
        }
        return mapped != null ? mapped : "application/octet-stream";
    }

    private boolean isKnownContentType(String contentType) {
        return contentType.startsWith("image/") || contentType.startsWith("audio/") || contentType.startsWith("video/")
                || contentType.startsWith("application/") || contentType.startsWith("text/");
    }

    private void deletePhysicalFile(String storagePath) {
        if (storagePath == null) {
            return;
        }
        try {
            java.io.File physical = new java.io.File(storagePath);
            if (physical.exists() && !physical.delete()) {
                logger.warn("Failed to delete physical file: {}", storagePath);
            }
        } catch (Exception e) {
            logger.warn("Failed to delete physical file: {}", storagePath, e);
        }
    }

    private void deleteDirectoryIfEmpty(Path directory) {
        try {
            if (Files.isDirectory(directory) && Files.list(directory).findAny().isEmpty()) {
                Files.delete(directory);
            }
        } catch (Exception e) {
            logger.warn("Failed to delete empty directory: {}", directory, e);
        }
    }

    private Set<String> parseAllowedExtensions(String config) {
        if (config == null || config.isBlank()) {
            return Collections.emptySet();
        }
        return config.toLowerCase(Locale.ROOT).lines()
                .flatMap(line -> java.util.Arrays.stream(line.split(",")))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .collect(Collectors.toSet());
    }
}
