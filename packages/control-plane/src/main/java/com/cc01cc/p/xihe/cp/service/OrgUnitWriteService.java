package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.controller.OrgUnitWireView;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.repository.OrgUnitReadRepository;
import com.cc01cc.p.xihe.cp.repository.OrgUnitWriteRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.sql.SQLException;
import java.util.UUID;

/**
 * PLAN-0773 M2-11 (batch B): create / rename / move, the three write endpoints.
 *
 * <p><b>Refusals come from the database where the database can judge</b>, and are translated here
 * rather than re-decided:</p>
 *
 * <ul>
 *   <li><b>Ring</b> — `trg_org_units_reject_cycle` (V165) raises SQLSTATE `XH001` inside the
 *       statement that changes `parent_id`. That is the authoritative refusal: a service-side
 *       pre-check alone would be a check that a forgotten code path (a future bulk move, a script)
 *       could skip. The pre-check below exists <b>only</b> to give the readable 422 without waiting
 *       for the constraint, and the trigger still catches anything it misses.</li>
 *   <li><b>Sibling name</b> — `uq_org_units_sibling_name` is `UNIQUE NULLS NOT DISTINCT
 *       (parent_id, name)` (V163), so two roots cannot share a name. A duplicate is `409`, never a
 *       second row: D-1116 says a UI hint cannot repair two units with one name — it can only say
 *       "exists", and the user wants "only one".</li>
 * </ul>
 *
 * <p>Scope and atom come from {@link OrgUnitAccess}, the same resolver the read face uses — so a
 * non-member's write attempt is a <b>404</b> (not 403) exactly as on the read face. That is the
 * regression this batch is most likely to introduce if someone "simplifies" it into a
 * `@PreAuthorize`, and it is pinned by a test.</p>
 */
@Service
public class OrgUnitWriteService {

    public static final String MANAGE_ATOM = ToolFaceRegistry.ACTION_MANAGE_ORG_UNITS;

    private static final Logger logger = LoggerFactory.getLogger(OrgUnitWriteService.class);

    /** PostgreSQL SQLSTATE raised by the V165 cycle trigger. */
    private static final String CYCLE_SQLSTATE = "XH001";
    private static final String UNIQUE_VIOLATION_SQLSTATE = "23505";

    private final OrgUnitReadRepository units;
    private final OrgUnitWriteRepository writer;
    private final OrgUnitAccess access;

    public OrgUnitWriteService(OrgUnitReadRepository units, OrgUnitWriteRepository writer,
                               OrgUnitAccess access) {
        this.units = units;
        this.writer = writer;
        this.access = access;
    }

    @Transactional
    public OrgUnitWireView.Created create(String nameValue, String parentIdValue) {
        OrgUnitAccess.Scope scope = access.resolve(MANAGE_ATOM);
        String name = requireName(nameValue);
        UUID parentId = OrgUnitAccess.parseUuid(parentIdValue, "INVALID_ORG_UNIT_ID");
        String parentPath = null;
        int parentDepth = -1;
        if (parentId != null) {
            OrgUnitReadRepository.UnitRow parent = units.findUnit(parentId)
                    .orElseThrow(OrgUnitAccess::notFound);
            scope.requireWithin(parent.path());
            parentPath = parent.path();
            parentDepth = parent.depth();
        } else {
            requireRootScope(scope);
        }
        UUID id = UUID.randomUUID();
        String path = parentPath == null ? label(id) : parentPath + "." + label(id);
        try {
            writer.insert(id, parentId, name, path, parentDepth + 1);
        } catch (DataAccessException e) {
            throw translate(e);
        }
        return new OrgUnitWireView.Created(id, path);
    }

    @Transactional
    public OrgUnitWireView.Node rename(String unitIdValue, String nameValue) {
        OrgUnitAccess.Scope scope = access.resolve(MANAGE_ATOM);
        String name = requireName(nameValue);
        OrgUnitReadRepository.UnitRow unit = require(unitIdValue, scope);
        try {
            writer.rename(unit.id(), name);
        } catch (DataAccessException e) {
            throw translate(e);
        }
        return node(unit.id(), name, unit.parentId(), unit.depth());
    }

    @Transactional
    public OrgUnitWireView.Node move(String unitIdValue, String parentIdValue) {
        OrgUnitAccess.Scope scope = access.resolve(MANAGE_ATOM);
        OrgUnitReadRepository.UnitRow unit = require(unitIdValue, scope);
        UUID parentId = OrgUnitAccess.parseUuid(parentIdValue, "INVALID_ORG_UNIT_ID");
        String parentPath = null;
        int newDepth = 0;
        if (parentId != null) {
            OrgUnitReadRepository.UnitRow parent = units.findUnit(parentId)
                    .orElseThrow(OrgUnitAccess::notFound);
            scope.requireWithin(parent.path());
            parentPath = parent.path();
            newDepth = parent.depth() + 1;
            // Readable 422 without waiting for the trigger. The trigger remains the judgement: this
            // check is only "say it nicely when we can already see it".
            if (OrgUnitAccess.within(parent.path(), unit.path())) {
                throw new CpApiException(HttpStatus.UNPROCESSABLE_ENTITY, "ORG_UNIT_CYCLE",
                        "an org unit cannot become a child of itself or of its own descendant");
            }
        } else {
            requireRootScope(scope);
        }
        String newSelfPath = parentPath == null ? label(unit.id()) : parentPath + "." + label(unit.id());
        try {
            writer.move(unit.id(), parentId, newSelfPath, newDepth, unit.path(), newDepth - unit.depth());
        } catch (DataAccessException e) {
            throw translate(e);
        }
        return node(unit.id(), unit.name(), parentId, newDepth);
    }

    private OrgUnitReadRepository.UnitRow require(String unitIdValue, OrgUnitAccess.Scope scope) {
        UUID unitId = OrgUnitAccess.parseUuid(unitIdValue, "INVALID_ORG_UNIT_ID");
        if (unitId == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_ORG_UNIT_ID",
                    "unitId must be a UUID");
        }
        OrgUnitReadRepository.UnitRow unit = units.findUnit(unitId)
                .orElseThrow(OrgUnitAccess::notFound);
        scope.requireWithin(unit.path());
        return unit;
    }

    private static OrgUnitWireView.Node node(UUID id, String name, UUID parentId, int depth) {
        return new OrgUnitWireView.Node(id, name, parentId, depth, false);
    }

    /**
     * A root sits above every unit, so creating one (or promoting a unit to a root) is an
     * instance-level act: a member's scope is its own subtree, and a unit outside that subtree is not
     * something it may create. Without this check the create endpoint would be the one write that
     * escapes the governance scope.
     */
    private static void requireRootScope(OrgUnitAccess.Scope scope) {
        if (!scope.wholeTree()) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "only an instance-level holder may create or promote a root unit");
        }
    }

    private static String requireName(String value) {
        if (value == null || value.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_ORG_UNIT_NAME",
                    "name is required and must not be blank");
        }
        String trimmed = value.trim();
        if (trimmed.length() > 120) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_ORG_UNIT_NAME",
                    "name must be at most 120 characters");
        }
        return trimmed;
    }

    /** ltree labels are UUIDs without hyphens (D-1116; the V163 CHECK enforces one spelling). */
    private static String label(UUID id) {
        return id.toString().replace("-", "");
    }

    /**
     * Translate the two database refusals this batch can produce.
     *
     * <p>Why {@link DataAccessException} and not {@link DataIntegrityViolationException}: the cycle
     * trigger raises SQLSTATE `XH001`, whose class (`XH`) is `X`-for-external, <b>not</b> the
     * integrity class `23`. Spring's translator therefore does <b>not</b> classify it as an
     * integrity violation — measured here: the same statement surfaces as
     * `UncategorizedSQLException`. Catching only the "obvious" type would leave the one refusal
     * this batch exists for unmapped (a 500 instead of 422) on the path the trigger actually takes.
     * Everything that is neither of the two states is re-thrown: a NULL or a foreign key the caller
     * should have checked is a bug, and a friendly 4xx would hide it.</p>
     */
    private CpApiException translate(DataAccessException exception) {
        SQLException sql = findSqlException(exception);
        if (sql != null && CYCLE_SQLSTATE.equals(sql.getSQLState())) {
            logger.info("[ORG-UNIT] event=cycle_refused sqlstate={} detail={}",
                    sql.getSQLState(), sql.getMessage());
            return new CpApiException(HttpStatus.UNPROCESSABLE_ENTITY, "ORG_UNIT_CYCLE",
                    "an org unit cannot become a child of itself or of its own descendant");
        }
        if (sql != null && UNIQUE_VIOLATION_SQLSTATE.equals(sql.getSQLState())) {
            return new CpApiException(HttpStatus.CONFLICT, "ORG_UNIT_NAME_CONFLICT",
                    "a sibling unit already uses this name");
        }
        throw exception;
    }

    private static SQLException findSqlException(Throwable throwable) {
        Throwable current = throwable;
        while (current != null) {
            if (current instanceof SQLException sql) {
                return sql;
            }
            current = current.getCause();
        }
        return null;
    }
}
