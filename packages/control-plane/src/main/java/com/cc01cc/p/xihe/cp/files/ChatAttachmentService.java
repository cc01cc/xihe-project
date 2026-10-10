package com.cc01cc.p.xihe.cp.files;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;
import com.cc01cc.p.xihe.cp.entity.File;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo;
import com.cc01cc.p.xihe.cp.files.dto.BatchUploadResult;
import com.cc01cc.p.xihe.cp.files.dto.UploadFailure;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;

import java.io.IOException;
import java.nio.file.FileVisitResult;
import java.nio.file.LinkOption;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
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
    private final com.cc01cc.p.xihe.cp.service.SessionAttachmentAnchorService sessionAnchor;
    private final WorkspaceRepository workspaceRepository;
    private final WorkspaceUserRepository workspaceUserRepository;
    private final ObjectMapper objectMapper;

    public ChatAttachmentService(
            @Value("${cp.attachments-base-path:/data/xihe/attachments}") String attachmentsBasePath,
            @Value("${cp.attachments.allowed-extensions:png,jpg,jpeg,gif,webp,svg,bmp,pdf,doc,docx,txt,md,json,csv,xls,xlsx,ppt,pptx,mp3,wav,m4a,ogg,flac,aac,mp4,webm,mov,avi,mkv}") String allowedExtensionsConfig,
            FileRepository fileRepository,
            com.cc01cc.p.xihe.cp.service.SessionAttachmentAnchorService sessionAnchor,
            WorkspaceRepository workspaceRepository,
            WorkspaceUserRepository workspaceUserRepository,
            ObjectMapper objectMapper) {
        this.attachmentsBasePath = attachmentsBasePath;
        this.allowedExtensions = parseAllowedExtensions(allowedExtensionsConfig);
        this.fileRepository = fileRepository;
        this.sessionAnchor = sessionAnchor;
        this.workspaceRepository = workspaceRepository;
        this.workspaceUserRepository = workspaceUserRepository;
        this.objectMapper = objectMapper;
    }

    @Transactional
    public BatchUploadResult upload(String sessionId, List<MultipartFile> files, String userId, String workspaceId) {
        verifyWorkspaceMembership(userId, workspaceId);
        ensureSessionExists(sessionId, workspaceId, userId);

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
                String fileId = entity.getId().toString();

                Path finalPath = sessionDir.resolve(fileId);
                Files.move(tempPath, finalPath);
                entity.setStoragePath(finalPath.toString());
                fileRepository.save(entity);

                success.add(new AttachmentInfo(fileId, originalName, mimeType, file.getSize(), "/api/v1/files/" + fileId));
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
        requireOwnedSession(sessionId, workspaceId, userId);
        File file = fileRepository.findByIdAndSessionIdForUpdate(UUID.fromString(fileId), sessionId)
                .orElseThrow(() -> new IllegalArgumentException("Attachment not found: " + fileId));
        verifyFileOwnership(file, userId, workspaceId);
        deletePhysicalFile(file.getStoragePath());
        fileRepository.delete(file);
        logger.info("Attachment deleted session={} fileId={}", sessionId, fileId);
    }

    @Transactional(readOnly = true)
    public File getMetadata(String sessionId, String fileId, String userId, String workspaceId) {
        verifyWorkspaceMembership(userId, workspaceId);
        requireOwnedSession(sessionId, workspaceId, userId);
        File file = fileRepository.findByIdAndSessionId(UUID.fromString(fileId), sessionId)
                .orElseThrow(() -> new IllegalArgumentException("Attachment not found: " + fileId));
        verifyFileOwnership(file, userId, workspaceId);
        return file;
    }

    public Optional<WorkspaceAttachmentDownload> findWorkspaceAttachmentForDownload(
            String fileId, String userId, String workspaceId) {
        File file = fileRepository.findById(UUID.fromString(fileId)).orElse(null);
        if (file == null) {
            return Optional.empty();
        }
        // Session ownership (archived / workspace / user mismatch) is enforced by the
        // session-domain anchor; null means missing or unowned — collapse to forbidden.
        Session session = sessionAnchor.findOwnedSession(file.getSessionId(), workspaceId, userId);
        if (session == null
                || !workspaceId.equals(file.getWorkspaceId())
                || !userId.equals(file.getUserId())
                || workspaceRepository.findByIdAndDeletedAtIsNull(UUID.fromString(workspaceId)).isEmpty()
                || workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(
                        UUID.fromString(workspaceId), UUID.fromString(userId)).isEmpty()) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "File access denied");
        }
        return Optional.of(new WorkspaceAttachmentDownload(
                Paths.get(file.getStoragePath()), file.getMimeType()));
    }

    public record WorkspaceAttachmentDownload(Path storagePath, String mimeType) {}

    public List<AttachmentInfo> resolveForChatSubmission(List<String> fileIds, String sessionId,
                                                         String workspaceId, String userId,
                                                         String sessionUserId) {
        List<AttachmentInfo> attachments = new ArrayList<>(fileIds.size());
        for (String fileId : fileIds) {
            File file = fileRepository.findById(UUID.fromString(fileId)).orElse(null);
            if (file == null) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "ATTACHMENT_NOT_FOUND", "Attachment not found");
            }
            if (!sessionId.equals(file.getSessionId())
                    || !workspaceId.equals(file.getWorkspaceId())
                    || !userId.equals(file.getUserId())
                    || !userId.equals(sessionUserId)) {
                throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "Attachment does not belong to session");
            }
            attachments.add(new AttachmentInfo(file.getId().toString(), file.getFilename(), file.getMimeType(),
                    file.getSizeBytes(), "/api/v1/files/" + file.getId()));
        }
        return List.copyOf(attachments);
    }

    public List<AttachmentInfo> resolveAdmittedMessageAttachments(String attachmentsJson) throws IOException {
        if (attachmentsJson == null || attachmentsJson.isBlank()) {
            return List.of();
        }
        com.fasterxml.jackson.databind.JsonNode refs = objectMapper.readTree(attachmentsJson);
        if (refs == null || !refs.isArray()) {
            throw new IllegalStateException("Admitted Follow-up attachment refs are invalid");
        }
        List<AttachmentInfo> attachments = new ArrayList<>();
        for (com.fasterxml.jackson.databind.JsonNode ref : refs) {
            UUID fileId = UUID.fromString(ref.path("fileId").asText());
            File file = fileRepository.findById(fileId)
                    .orElseThrow(() -> new IllegalStateException("Admitted Follow-up File is missing"));
            attachments.add(new AttachmentInfo(file.getId().toString(), file.getFilename(), file.getMimeType(),
                    file.getSizeBytes(), "/api/v1/files/" + file.getId()));
        }
        return List.copyOf(attachments);
    }

    @Transactional
    public void deleteSessionAttachments(String sessionId) {
        List<File> files = fileRepository.findBySessionIdOrderByIdAsc(sessionId);
        for (File candidate : files) {
            // Share the same lock and deterministic order as an in-flight fork copy.
            File file = fileRepository.findByIdForUpdate(candidate.getId()).orElse(null);
            if (file == null) {
                continue;
            }
            deletePhysicalFile(file.getStoragePath());
            fileRepository.delete(file);
            logger.info("Session attachment deleted session={} fileId={}", sessionId, file.getId());
        }
        fileRepository.deleteBySessionId(sessionId);
        deleteDirectoryIfEmpty(Paths.get(attachmentsBasePath, sessionId));
    }

    @Transactional
    public void detachMessageFiles(String messageId) {
        for (File candidate : fileRepository.findByMessageIdOrderByIdAsc(messageId)) {
            File file = fileRepository.findByIdForUpdate(candidate.getId()).orElse(null);
            if (file != null && messageId.equals(file.getMessageId())) {
                file.setMessageId(null);
                fileRepository.save(file);
            }
        }
    }

    /**
     * PLAN-0470 (decision #23): ChatSubmission links admitted attachments to
     * the freshly created user Message through the Files owner. Joins the
     * caller's ChatSubmission transaction — a Message save failure rolls the
     * link updates back with it. No physical file is deleted and no HTTP
     * response field changes; the "attachment disappeared" failure text is
     * preserved from the previous direct write.
     */
    @Transactional
    public void linkToMessage(List<String> attachmentIds, String messageId) {
        for (String fileId : attachmentIds) {
            File file = fileRepository.findById(UUID.fromString(fileId))
                    .orElseThrow(() -> new IllegalStateException("Attachment disappeared during Chat submission"));
            file.setMessageId(messageId);
            fileRepository.save(file);
        }
    }

    /**
     * PLAN-0470 (T3.2): lock the source attachment rows for a fork copy so the
     * fork coordinator does not inject {@code FileRepository} directly. Returns
     * the locked rows ordered by id; ownership is asserted by the caller's
     * already-authenticated session scope.
     */
    @Transactional
    public List<File> lockForForkCopy(List<String> messageIds) {
        return fileRepository.findByMessageIdsForUpdateOrderByIdAsc(messageIds);
    }

    public File copyForFork(UUID sourceFileId, String sourceSessionId, String sourceMessageId,
                            String childSessionId, String childMessageId, String userId, String workspaceId) {
        File source = fileRepository.findByIdAndSessionIdForUpdate(sourceFileId, sourceSessionId)
                .orElseThrow(() -> new CpApiException(HttpStatus.CONFLICT, "FORK_SOURCE_ATTACHMENT_CHANGED",
                        "A source attachment changed during fork copy"));
        if (!sourceMessageId.equals(source.getMessageId())) {
            throw new CpApiException(HttpStatus.CONFLICT, "FORK_SOURCE_ATTACHMENT_CHANGED",
                    "A source attachment changed during fork copy");
        }
        verifyFileOwnership(source, userId, workspaceId);
        try {
            Path sourcePath = resolveSourceFilePath(sourceSessionId, source);
            Path childDirectory = resolveSessionDirectory(childSessionId);
            Path temporaryPath = Files.createTempFile(childDirectory, ".fork-", ".tmp");
            Files.copy(sourcePath, temporaryPath, StandardCopyOption.REPLACE_EXISTING);
            if (Files.size(temporaryPath) != source.getSizeBytes()) {
                throw new IOException("Copied attachment size did not match its source metadata");
            }

            File child = new File();
            child.setUserId(userId);
            child.setWorkspaceId(workspaceId);
            child.setSessionId(childSessionId);
            child.setMessageId(childMessageId);
            child.setFilename(source.getFilename());
            child.setMimeType(source.getMimeType());
            child.setSizeBytes(source.getSizeBytes());
            child.setStoragePath(temporaryPath.toString());
            child = fileRepository.saveAndFlush(child);

            Path childPath = childDirectory.resolve(child.getId().toString());
            Files.move(temporaryPath, childPath);
            child.setStoragePath(childPath.toString());
            return fileRepository.save(child);
        } catch (IOException e) {
            logger.error("Fork attachment copy failed sourceFileId={} childSessionId={}",
                    sourceFileId, childSessionId, e);
            throw new CpApiException(HttpStatus.CONFLICT, "FORK_SOURCE_ATTACHMENT_CHANGED",
                    "A source attachment changed or became unavailable during fork copy", e);
        }
    }

    public void deleteForkNamespaceStrict(String cleanupRef) throws IOException {
        UUID childSessionId;
        try {
            childSessionId = UUID.fromString(cleanupRef);
        } catch (IllegalArgumentException e) {
            logger.error("Invalid fork cleanup reference");
            throw new IOException("Invalid fork cleanup reference", e);
        }

        Path root = attachmentsRoot();
        Path namespace = root.resolve(childSessionId.toString()).normalize();
        requireContained(namespace, root);
        if (!Files.exists(namespace, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        if (Files.isSymbolicLink(namespace)) {
            Files.delete(namespace);
        } else {
            Path realNamespace = namespace.toRealPath();
            requireContained(realNamespace, root);
            Files.walkFileTree(realNamespace, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                    Files.delete(file);
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult postVisitDirectory(Path directory, IOException error) throws IOException {
                    if (error != null) {
                        throw error;
                    }
                    Files.delete(directory);
                    return FileVisitResult.CONTINUE;
                }
            });
        }
        if (Files.exists(namespace, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Fork cleanup did not remove its child namespace");
        }
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

    // Session existence + ownership write/check lives in the session-domain anchor
    // (PLAN-0470 T3.2); this files service no longer touches SessionRepository.
    private void ensureSessionExists(String sessionId, String workspaceId, String userId) {
        sessionAnchor.ensureExistsForAttachment(sessionId, workspaceId, userId);
    }

    private Session requireOwnedSession(String sessionId, String workspaceId, String userId) {
        // Two distinct failures preserved from the pre-refactor contract: a missing
        // row is "not found", an archived/mismatched row is "access denied".
        Session session = sessionAnchor.findExistingSession(sessionId)
                .orElseThrow(() -> new IllegalArgumentException("Session not found"));
        if (session.isArchived()
                || !workspaceId.equals(session.getWorkspaceId())
                || !userId.equals(session.getUserId())) {
            throw new IllegalArgumentException("Session access denied");
        }
        return session;
    }

    private void verifyFileOwnership(File file, String userId, String workspaceId) {
        if (!userId.equals(file.getUserId()) || !workspaceId.equals(file.getWorkspaceId())) {
            throw new IllegalArgumentException("Attachment access denied");
        }
    }

    private void verifyWorkspaceMembership(String userId, String workspaceId) {
        if (workspaceId == null || userId == null) {
            throw new IllegalArgumentException("Workspace or user context missing");
        }
        if (workspaceRepository.findByIdAndDeletedAtIsNull(UUID.fromString(workspaceId)).isEmpty()
                || workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(UUID.fromString(workspaceId), UUID.fromString(userId)).isEmpty()) {
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

    private Path resolveSourceFilePath(String sourceSessionId, File source) throws IOException {
        UUID sourceSessionUuid;
        try {
            sourceSessionUuid = UUID.fromString(sourceSessionId);
        } catch (IllegalArgumentException e) {
            throw new IOException("Invalid source Session identifier", e);
        }
        Path root = attachmentsRoot();
        Path sourceDirectory = root.resolve(sourceSessionUuid.toString()).normalize();
        requireContained(sourceDirectory, root);
        if (Files.isSymbolicLink(sourceDirectory) || !Files.isDirectory(sourceDirectory, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Fork source attachment directory is unavailable");
        }
        Path realDirectory = sourceDirectory.toRealPath();
        requireContained(realDirectory, root);

        if (source.getStoragePath() == null || source.getStoragePath().isBlank()) {
            throw new IOException("Fork source attachment has no storage path");
        }
        Path storedPath = Paths.get(source.getStoragePath()).toAbsolutePath().normalize();
        if (Files.isSymbolicLink(storedPath)) {
            throw new IOException("Fork source attachment cannot be a symbolic link");
        }
        Path realFile = storedPath.toRealPath();
        requireContained(realFile, realDirectory);
        if (!Files.isRegularFile(realFile, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Fork source attachment is not a regular file");
        }
        return realFile;
    }

    private Path resolveSessionDirectory(String sessionId) throws IOException {
        UUID sessionUuid;
        try {
            sessionUuid = UUID.fromString(sessionId);
        } catch (IllegalArgumentException e) {
            throw new IOException("Invalid child Session identifier", e);
        }
        Path root = attachmentsRoot();
        Path directory = root.resolve(sessionUuid.toString()).normalize();
        requireContained(directory, root);
        if (Files.isSymbolicLink(directory)) {
            throw new IOException("Fork child attachment directory cannot be a symbolic link");
        }
        Files.createDirectories(directory);
        Path realDirectory = directory.toRealPath();
        requireContained(realDirectory, root);
        return realDirectory;
    }

    private Path attachmentsRoot() throws IOException {
        Path configuredRoot = Paths.get(attachmentsBasePath).toAbsolutePath().normalize();
        Files.createDirectories(configuredRoot);
        return configuredRoot.toRealPath();
    }

    private void requireContained(Path candidate, Path root) throws IOException {
        String normalizedCandidate = candidate.toAbsolutePath().normalize().toString()
                .replace('\\', '/').toLowerCase(Locale.ROOT);
        String normalizedRoot = root.toAbsolutePath().normalize().toString()
                .replace('\\', '/').toLowerCase(Locale.ROOT);
        String rootPrefix = normalizedRoot.endsWith("/") ? normalizedRoot : normalizedRoot + "/";
        if (!normalizedCandidate.equals(normalizedRoot) && !normalizedCandidate.startsWith(rootPrefix)) {
            throw new IOException("Attachment path escapes its configured root");
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
