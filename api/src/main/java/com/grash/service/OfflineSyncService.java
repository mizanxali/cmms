package com.grash.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.grash.dto.TaskPatchDTO;
import com.grash.dto.WorkOrderChangeStatusDTO;
import com.grash.dto.comment.CommentPostDTO;
import com.grash.dto.offline.OfflineEnvelopeDTO;
import com.grash.dto.offline.OfflineOpResultDTO;
import com.grash.dto.workOrder.WorkOrderPatchDTO;
import com.grash.exception.CustomException;
import com.grash.mapper.TaskMapper;
import com.grash.mapper.WorkOrderMapper;
import com.grash.model.*;
import com.grash.model.enums.OfflineOpResult;
import com.grash.model.enums.Status;
import com.grash.repository.OfflineDeviceRepository;
import com.grash.repository.OfflineOpRepository;
import com.grash.utils.Helper;
import lombok.RequiredArgsConstructor;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.*;

import static com.grash.model.enums.OfflineOpResult.*;

/**
 * Applies uploaded offline ops exactly once, as their author, under the server-wins policy.
 */
@Service
@RequiredArgsConstructor
public class OfflineSyncService {

    private static final Set<String> TYPES = Set.of("NOTE", "STATUS", "TASK_UPDATE", "HANDOFF_REQUEST",
            "HANDOFF_ACCEPT");
    private static final byte[] ED25519_SPKI_PREFIX = HexFormat.of().parseHex("302a300506032b6570032100");
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm");

    private final OfflineOpRepository offlineOpRepository;
    private final OfflineDeviceRepository offlineDeviceRepository;
    private final WorkOrderService workOrderService;
    private final WorkOrderMapper workOrderMapper;
    private final TaskService taskService;
    private final TaskMapper taskMapper;
    private final CommentService commentService;
    private final ObjectMapper objectMapper;
    private final PlatformTransactionManager transactionManager;

    private record Parsed(int index, OfflineEnvelopeDTO envelope, JsonNode body) {
    }

    /**
     * Processes ops in (lamport, authorAddress) order, each in its own transaction; results come back in input order.
     */
    public List<OfflineOpResultDTO> sync(List<OfflineEnvelopeDTO> envelopes, User uploader) {
        TransactionTemplate tx = new TransactionTemplate(transactionManager);
        OfflineOpResultDTO[] results = new OfflineOpResultDTO[envelopes.size()];
        List<Parsed> parsed = new ArrayList<>();
        for (int i = 0; i < envelopes.size(); i++) {
            JsonNode body = parseBody(envelopes.get(i), uploader);
            if (body == null) results[i] = new OfflineOpResultDTO(null, REJECTED, "bad_envelope", null, null);
            else parsed.add(new Parsed(i, envelopes.get(i), body));
        }
        parsed.sort(Comparator.<Parsed>comparingLong(p -> p.body.get("lamport").asLong())
                .thenComparing(p -> p.body.get("authorAddress").asText()));
        for (Parsed p : parsed) results[p.index] = process(tx, p, uploader);
        return Arrays.asList(results);
    }

    private OfflineOpResultDTO process(TransactionTemplate tx, Parsed p, User uploader) {
        String opId = p.body.get("opId").asText();
        try {
            return tx.execute(status -> apply(p, uploader));
        } catch (DataIntegrityViolationException e) {
            // A concurrent upload of the same op won the insert
            return tx.execute(status -> duplicate(offlineOpRepository.findByOpId(opId).orElseThrow()));
        } catch (CustomException e) {
            // An Atlas service refused the change. Stored, so the answer is final like any other rejection.
            return tx.execute(status -> finish(newRow(p, uploader), REJECTED, truncate("error: " + e.getMessage())));
        }
    }

    private OfflineOpResultDTO apply(Parsed p, User uploader) {
        Optional<OfflineOp> existing = offlineOpRepository.findByOpId(p.body.get("opId").asText());
        if (existing.isPresent()) return duplicate(existing.get());
        // Claim the op id first: the unique constraint makes a concurrent upload of the same op a DUPLICATE
        OfflineOp row = offlineOpRepository.saveAndFlush(newRow(p, uploader));

        String rejection = verify(p, row);
        if (rejection != null) return finish(row, REJECTED, rejection);

        Authentication uploaderAuth = SecurityContextHolder.getContext().getAuthentication();
        Helper.setCurrentUser(row.getAuthorUser()); // comments, Envers and createdBy are the author's
        try {
            String conflict = applyAsAuthor(p.body, row.getWorkOrder(), row.getAuthorUser(), uploader);
            return conflict == null ? finish(row, APPLIED, null) : finish(row, CONFLICT, conflict);
        } finally {
            SecurityContextHolder.getContext().setAuthentication(uploaderAuth);
        }
    }

    private String verify(Parsed p, OfflineOp row) {
        if (row.getWorkOrder() == null) return "bad_envelope";
        OfflineDevice device = offlineDeviceRepository.findByAddress(row.getAuthorAddress()).orElse(null);
        if (device == null || !device.getUser().getId().equals(p.body.get("authorUserId").asLong()))
            return "unknown_device";
        row.setAuthorUser(device.getUser());
        if (!signatureValid(device.getPublicKey(), p.envelope)) return "bad_signature";
        if (!row.getWorkOrder().canBeEditedBy(device.getUser())) return "forbidden";
        return null;
    }

    /**
     * Applies the op with compare-and-set. Returns null when applied, or the server's current value on conflict.
     */
    private String applyAsAuthor(JsonNode body, WorkOrder workOrder, User author, User uploader) {
        JsonNode payload = body.get("payload");
        Comments comments = new Comments(workOrder, author, uploader, body.get("occurredAt").asLong());
        switch (body.get("type").asText()) {
            case "NOTE" -> {
                comments.add("[Offline update · %s] %s", comments.time, payload.path("text").asText());
                return null;
            }
            case "HANDOFF_REQUEST" -> {
                String note = payload.path("note").asText("");
                comments.add("[Offline handoff · %s] %s requested a handoff.%s", comments.time, author.getFullName(),
                        note.isBlank() ? "" : " Note: " + note);
                return null;
            }
            case "STATUS" -> {
                String base = payload.path("base").asText(), to = payload.path("to").asText();
                String current = workOrder.getStatus().name();
                if (!current.equals(base)) return comments.conflict("status", to, base, current);
                WorkOrderChangeStatusDTO dto = new WorkOrderChangeStatusDTO();
                dto.setStatus(status(to));
                workOrderService.changeStatus(dto, workOrder.getId(), author, "OFFLINE");
                return null;
            }
            case "TASK_UPDATE" -> {
                long taskId = payload.path("taskId").asLong();
                boolean notes = "notes".equals(payload.path("field").asText());
                Task task = taskService.findById(taskId)
                        .filter(t -> t.getWorkOrder() != null && t.getWorkOrder().getId().equals(workOrder.getId()))
                        .orElseThrow(() -> new CustomException("Task not on this work order", HttpStatus.BAD_REQUEST));
                String base = text(payload.get("base")), to = text(payload.get("to"));
                String current = blankToNull(notes ? task.getNotes() : task.getValue());
                String field = task.getTaskBase().getLabel() + (notes ? " notes" : "");
                if (!Objects.equals(current, blankToNull(base)))
                    return comments.conflict(field, display(to), display(base), display(current));
                TaskPatchDTO dto = taskMapper.toPatchDto(task); // full copy: the mapper nulls whatever is missing
                if (notes) dto.setNotes(to);
                else dto.setValue(to);
                taskService.update(taskId, dto);
                return null;
            }
            case "HANDOFF_ACCEPT" -> {
                JsonNode baseNode = payload.get("basePrimaryUserId");
                Long base = baseNode == null || baseNode.isNull() ? null : baseNode.asLong();
                User primary = workOrder.getPrimaryUser();
                if (!Objects.equals(primary == null ? null : primary.getId(), base))
                    return comments.conflict("primary assignee", author.getFullName(), nameOf(workOrder, base),
                            primary == null ? "none" : primary.getFullName());
                User requester = offlineOpRepository.findByOpId(payload.path("requestOpId").asText())
                        .map(OfflineOp::getAuthorUser).orElse(primary);
                WorkOrderPatchDTO dto = workOrderMapper.toPatchDto(workOrder); // full copy, as above
                List<User> assigned = new ArrayList<>(dto.getAssignedTo() == null ? List.of() : dto.getAssignedTo());
                for (User u : new User[]{requester, author})
                    if (u != null && assigned.stream().noneMatch(a -> a.getId().equals(u.getId()))) assigned.add(u);
                dto.setAssignedTo(assigned);
                dto.setPrimaryUser(author);
                workOrderService.patch(workOrder.getId(), dto, author);
                comments.add("[Offline handoff · %s] %s accepted responsibility (requested by %s). Primary assignee " +
                                "is now %s.", comments.time, author.getFullName(),
                        requester == null ? "unknown" : requester.getFullName(), author.getFullName());
                return null;
            }
            default -> throw new CustomException("Unknown op type", HttpStatus.BAD_REQUEST);
        }
    }

    /**
     * Comments are written as the author, with the offline comment templates.
     */
    private class Comments {
        private final WorkOrder workOrder;
        private final User author;
        private final String suffix;
        private final String time;

        Comments(WorkOrder workOrder, User author, User uploader, long occurredAt) {
            this.workOrder = workOrder;
            this.author = author;
            this.suffix = uploader.getId().equals(author.getId()) ? "" : " · synced by " + uploader.getFullName();
            this.time = TIME.format(Instant.ofEpochMilli(occurredAt).atZone(zoneOf(author)));
        }

        void add(String template, Object... args) {
            CommentPostDTO dto = new CommentPostDTO();
            dto.setWorkOrder(workOrder);
            dto.setContent(template.formatted(args) + suffix);
            commentService.create(dto, author);
        }

        String conflict(String field, String to, String base, String current) {
            add("[Offline conflict · %s] %s's offline change was not applied: %s → %s (expected %s, server has %s).",
                    time, author.getFullName(), field, to, base, current);
            return truncate(current);
        }
    }

    // ─── Rows and results ───────────────────────────────────

    private OfflineOp newRow(Parsed p, User uploader) {
        OfflineOp row = new OfflineOp();
        row.setOpId(p.body.get("opId").asText());
        row.setWorkOrder(workOrderService.findById(p.body.get("workOrderId").asLong()).orElse(null));
        row.setType(p.body.get("type").asText());
        row.setAuthorAddress(p.body.get("authorAddress").asText());
        row.setLamport(p.body.get("lamport").asLong());
        row.setOccurredAt(new Date(p.body.get("occurredAt").asLong()));
        row.setBody(p.envelope.getBody());
        row.setSig(p.envelope.getSig());
        row.setUploadedBy(uploader);
        return row;
    }

    private OfflineOpResultDTO finish(OfflineOp row, OfflineOpResult result, String detail) {
        row.setResult(result);
        row.setDetail(detail);
        return toDto(offlineOpRepository.saveAndFlush(row), result, detail);
    }

    // DUPLICATE carries the stored outcome in `detail`: "<RESULT>" or "<RESULT>: <detail>"
    private OfflineOpResultDTO duplicate(OfflineOp stored) {
        String original = stored.getResult() + (stored.getDetail() == null ? "" : ": " + stored.getDetail());
        return toDto(stored, DUPLICATE, truncate(original));
    }

    private static OfflineOpResultDTO toDto(OfflineOp row, OfflineOpResult result, String detail) {
        return new OfflineOpResultDTO(row.getOpId(), result, detail,
                row.getUploadedBy() == null ? null : row.getUploadedBy().getId(), row.getCreatedAt().getTime());
    }

    // ─── Parsing and verification ───────────────────────────

    // Step 1 of the pipeline: a well-formed v1 body for the uploader's company, or null.
    private JsonNode parseBody(OfflineEnvelopeDTO envelope, User uploader) {
        if (envelope == null || envelope.getBody() == null || envelope.getSig() == null) return null;
        try {
            JsonNode b = objectMapper.readTree(envelope.getBody());
            boolean ok = b.path("v").asInt() == 1
                    && b.path("opId").isTextual() && b.get("opId").asText().length() <= 64
                    && b.path("companyId").asLong() == uploader.getCompany().getId()
                    && b.path("workOrderId").canConvertToLong()
                    && TYPES.contains(b.path("type").asText())
                    && b.path("authorUserId").canConvertToLong()
                    && b.path("authorAddress").isTextual()
                    && b.path("lamport").canConvertToLong()
                    && b.path("occurredAt").canConvertToLong()
                    && b.path("payload").isObject();
            return ok ? b : null;
        } catch (Exception e) {
            return null;
        }
    }

    // Ed25519 over the exact UTF-8 bytes of the body string, with the registered raw 32-byte key
    static boolean signatureValid(String publicKeyB64, OfflineEnvelopeDTO envelope) {
        try {
            byte[] raw = Base64.getDecoder().decode(publicKeyB64);
            byte[] spki = new byte[ED25519_SPKI_PREFIX.length + raw.length];
            System.arraycopy(ED25519_SPKI_PREFIX, 0, spki, 0, ED25519_SPKI_PREFIX.length);
            System.arraycopy(raw, 0, spki, ED25519_SPKI_PREFIX.length, raw.length);
            Signature verifier = Signature.getInstance("Ed25519");
            verifier.initVerify(KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(spki)));
            verifier.update(envelope.getBody().getBytes(StandardCharsets.UTF_8));
            return verifier.verify(Base64.getDecoder().decode(envelope.getSig()));
        } catch (Exception e) {
            return false;
        }
    }

    // ─── Small helpers ──────────────────────────────────────

    private static Status status(String name) {
        try {
            return Status.valueOf(name);
        } catch (IllegalArgumentException e) {
            throw new CustomException("Unknown status " + name, HttpStatus.BAD_REQUEST);
        }
    }

    private static ZoneId zoneOf(User user) {
        try {
            return ZoneId.of(user.getCompany().getCompanySettings().getGeneralPreferences().getTimeZone());
        } catch (Exception e) {
            return ZoneId.of("UTC");
        }
    }

    private static String nameOf(WorkOrder workOrder, Long userId) {
        if (userId == null) return "none";
        return workOrder.getUsers().stream().filter(u -> u.getId().equals(userId)).findFirst()
                .map(User::getFullName).orElse("user " + userId);
    }

    private static String text(JsonNode node) {
        return node == null || node.isNull() ? null : node.asText();
    }

    private static String blankToNull(String s) {
        return s == null || s.isEmpty() ? null : s;
    }

    private static String display(String s) {
        return s == null ? "empty" : s;
    }

    private static String truncate(String s) {
        return s == null || s.length() <= 255 ? s : s.substring(0, 255);
    }
}
