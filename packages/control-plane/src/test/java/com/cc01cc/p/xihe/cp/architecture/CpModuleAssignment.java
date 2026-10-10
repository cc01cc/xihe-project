package com.cc01cc.p.xihe.cp.architecture;

import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.library.dependencies.SliceAssignment;
import com.tngtech.archunit.library.dependencies.SliceIdentifier;

import java.util.Set;

final class CpModuleAssignment implements SliceAssignment {

    private static final String ROOT = "com.cc01cc.p.xihe.cp";
    private static final Set<String> MIXED = Set.of("controller", "service", "entity", "repository");

    String ownerOf(JavaClass type) {
        if (type.isArray()) {
            type = type.getBaseComponentType();
        }
        String packageName = type.getPackageName();
        if (packageName.equals(ROOT)) {
            return "bootstrap";
        }
        if (!packageName.startsWith(ROOT + ".")) {
            return null;
        }
        String localPackage = packageName.substring(ROOT.length() + 1);
        String top = localPackage.split("\\.", 2)[0];
        if (!MIXED.contains(top)) {
            return top;
        }
        String name = type.getName().substring(packageName.length() + 1).split("\\$", 2)[0];
        if (name.startsWith("WorkspaceJob")) {
            return "operation";
        }
        if (name.startsWith("WorkspaceImport")) {
            return "importjob";
        }
        if (name.startsWith("WorkspaceEvent")) {
            return "event";
        }
        if (name.startsWith("Workspace")) {
            return "workspace";
        }
        if (name.startsWith("Agent")) {
            return "principal";
        }
        if (name.startsWith("ContextTemplate")) {
            return "context";
        }
        if (name.startsWith("Runtime")) {
            return "runtime";
        }
        if (name.startsWith("RunCheckpoint")) {
            return "checkpoint";
        }
        if (name.startsWith("Mcp")) {
            return "mcp";
        }
        if (name.startsWith("Provider")) {
            return "provider";
        }
        if (name.startsWith("OAuth")) {
            return "oauth";
        }
        if (name.startsWith("Policy") || name.startsWith("ToolFace") || name.startsWith("AuthorizationGrant")) {
            return "policy";
        }
        if (name.startsWith("Config") || name.equals("ImportService") || name.equals("ExportService")) {
            return "config";
        }
        if (name.startsWith("File")) {
            return "files";
        }
        if (name.startsWith("User")) {
            return "auth";
        }
        if (name.startsWith("AuditLog")) {
            return "audit";
        }
        if (name.equals("UuidStringConverter")) {
            return "persistence";
        }
        if (name.startsWith("Session") || name.startsWith("Chat") || name.startsWith("Approval")
                || name.startsWith("Message") || name.startsWith("Inbox") || name.startsWith("Task")
                || name.equals("BranchPathService") || name.equals("RootBranchBinder")) {
            return "chat";
        }
        throw new IllegalArgumentException("Unassigned mixed-package production type: " + type.getName());
    }

    @Override
    public SliceIdentifier getIdentifierOf(JavaClass type) {
        String owner = ownerOf(type);
        return owner == null ? SliceIdentifier.ignore() : SliceIdentifier.of(owner);
    }

    @Override
    public String getDescription() { return "the frozen CP capability ownership matrix"; }
}
