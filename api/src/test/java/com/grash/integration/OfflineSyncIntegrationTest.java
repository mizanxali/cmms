package com.grash.integration;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.grash.dto.offline.OfflineDevicePostDTO;
import com.grash.dto.offline.OfflineEnvelopeDTO;
import com.grash.dto.offline.OfflineOpResultDTO;
import com.grash.model.*;
import com.grash.model.enums.*;
import com.grash.repository.*;
import com.grash.service.OfflineDeviceService;
import com.grash.service.OfflineSyncService;
import com.grash.service.WebhookDispatchService;
import jakarta.persistence.EntityManager;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.util.*;

import static com.grash.model.enums.OfflineOpResult.*;
import static com.grash.utils.Helper.setCurrentUser;
import static org.junit.jupiter.api.Assertions.*;

/**
 * Rolled back like the other integration tests. The service's per-op TransactionTemplate joins the test transaction
 * here; in production each op commits on its own (verified on devices).
 */
@Transactional
class OfflineSyncIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private OfflineSyncService offlineSyncService;
    @Autowired
    private OfflineDeviceService offlineDeviceService;
    @Autowired
    private WorkOrderRepository workOrderRepository;
    @Autowired
    private TaskRepository taskRepository;
    @Autowired
    private TaskBaseRepository taskBaseRepository;
    @Autowired
    private UserRepository userRepository;
    @Autowired
    private CompanyRepository companyRepository;
    @Autowired
    private RoleRepository roleRepository;
    @Autowired
    private CompanySettingsRepository companySettingsRepository;
    @Autowired
    private SubscriptionRepository subscriptionRepository;
    @Autowired
    private SubscriptionPlanRepository subscriptionPlanRepository;
    @Autowired
    private GeneralPreferencesRepository generalPreferencesRepository;
    @Autowired
    private ObjectMapper objectMapper;
    @Autowired
    private EntityManager em;
    @Autowired
    private PlatformTransactionManager transactionManager;

    @MockitoBean
    private WebhookDispatchService webhookDispatchService;

    private TransactionTemplate tx;
    private Company company;
    private Device alice;
    private Device bob;
    private Device carol;
    private Long workOrderId;
    private Long taskId;
    private int lamport;

    private record Device(User user, KeyPair keys, String address) {
    }

    @BeforeEach
    void setUp() throws Exception {
        tx = new TransactionTemplate(transactionManager);
        String suffix = UUID.randomUUID().toString().substring(0, 8);
        User[] users = fixture(suffix);
        alice = device(users[0]);
        bob = device(users[1]);
        carol = device(users[2]);

        setCurrentUser(alice.user); // the creator may edit, so the work order must not be created as Carol
        WorkOrder wo = new WorkOrder();
        wo.setTitle("CH-2 quarterly inspection");
        wo.setStatus(Status.OPEN);
        wo.setPriority(Priority.MEDIUM);
        wo.setEstimatedDuration(2.0);
        wo.setCompany(company);
        wo.setPrimaryUser(alice.user);
        wo.setAssignedTo(new ArrayList<>(List.of(alice.user, bob.user)));
        wo.setCustomers(new ArrayList<>());
        wo.setFiles(new ArrayList<>());
        wo.setCustomFieldValues(new ArrayList<>());
        workOrderId = workOrderRepository.saveAndFlush(wo).getId();

        TaskBase base = new TaskBase();
        base.setLabel("Check refrigerant level");
        base.setTaskType(TaskType.SUBTASK);
        base = taskBaseRepository.save(base);
        Task task = new Task(base, workOrderRepository.findById(workOrderId).orElseThrow(), null, "OPEN");
        task.setNotes("leak check pending");
        taskId = taskRepository.save(task).getId();
        lamport = 0;
    }

    private User[] fixture(String suffix) {
        SubscriptionPlan plan = subscriptionPlanRepository.save(SubscriptionPlan.builder()
                .name("Plan " + suffix).monthlyCostPerUser(10.0).yearlyCostPerUser(100.0)
                .features(new HashSet<>()).build());
        Subscription subscription = subscriptionRepository.save(Subscription.builder()
                .usersCount(5).subscriptionPlan(plan).build());
        CompanySettings settings = companySettingsRepository.save(new CompanySettings());
        company = new Company("Offline " + suffix, 10, subscription);
        company.setCompanySettings(settings);
        company = companyRepository.save(company);
        settings.setCompany(company);
        companySettingsRepository.save(settings);
        GeneralPreferences preferences = settings.getGeneralPreferences();
        preferences.setTimeZone("UTC"); // comment times are formatted in the company's zone
        generalPreferencesRepository.save(preferences);

        Role technician = roleRepository.save(Role.builder()
                .name("Technician").roleType(RoleType.ROLE_CLIENT).code(RoleCode.TECHNICIAN)
                .companySettings(settings)
                .createPermissions(new HashSet<>(List.of(PermissionEntity.WORK_ORDERS)))
                .viewPermissions(new HashSet<>(List.of(PermissionEntity.WORK_ORDERS)))
                .viewOtherPermissions(new HashSet<>(List.of(PermissionEntity.WORK_ORDERS)))
                .editOtherPermissions(new HashSet<>())
                .deleteOtherPermissions(new HashSet<>())
                .build());

        return new User[]{user("Alice", technician, suffix), user("Bob", technician, suffix),
                user("Carol", technician, suffix)};
    }

    private User user(String name, Role role, String suffix) {
        User user = new User();
        user.setFirstName(name);
        user.setLastName("Tech");
        user.setEmail(name.toLowerCase() + "-" + suffix + "@offline.test");
        user.setUsername(name.toLowerCase() + "-" + suffix);
        user.setPassword("encoded");
        user.setRole(role);
        user.setCompany(company);
        user.setEnabled(true);
        user.setSuperAccountRelations(new ArrayList<>());
        user.setUserSettings(new UserSettings());
        return userRepository.save(user);
    }

    private Device device(User user) throws Exception {
        KeyPair keys = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        byte[] spki = keys.getPublic().getEncoded();
        byte[] raw = Arrays.copyOfRange(spki, spki.length - 32, spki.length);
        OfflineDevicePostDTO dto = new OfflineDevicePostDTO();
        dto.setAddress(OfflineDeviceService.deriveAddress(raw));
        dto.setPublicKey(Base64.getEncoder().encodeToString(raw));
        setCurrentUser(user);
        offlineDeviceService.register(dto, user);
        return new Device(user, keys, dto.getAddress());
    }

    // ─── Building signed envelopes ─────────

    private OfflineEnvelopeDTO op(Device author, String type, Map<String, Object> payload) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("v", 1);
        body.put("opId", UUID.randomUUID().toString().replace("-", "").substring(0, 24));
        body.put("companyId", company.getId());
        body.put("workOrderId", workOrderId);
        body.put("type", type);
        body.put("authorUserId", author.user.getId());
        body.put("authorAddress", author.address);
        body.put("lamport", ++lamport);
        body.put("occurredAt", 1_790_000_000_000L + lamport * 60_000L);
        body.put("payload", payload);
        String json = objectMapper.writeValueAsString(body);
        Signature signer = Signature.getInstance("Ed25519");
        signer.initSign(author.keys.getPrivate());
        signer.update(json.getBytes(StandardCharsets.UTF_8));
        return new OfflineEnvelopeDTO(json, Base64.getEncoder().encodeToString(signer.sign()));
    }

    private static String opId(OfflineEnvelopeDTO envelope) {
        return envelope.getBody().replaceAll(".*\"opId\":\"([0-9a-f]+)\".*", "$1");
    }

    private List<OfflineOpResultDTO> upload(Device uploader, OfflineEnvelopeDTO... ops) {
        setCurrentUser(uploader.user);
        return offlineSyncService.sync(List.of(ops), uploader.user);
    }

    private List<String> comments() {
        return tx.execute(s -> em.createQuery("select c from Comment c where c.workOrder.id = :id order by c.id",
                        Comment.class).setParameter("id", workOrderId).getResultList().stream()
                .map(c -> c.getUser().getFirstName() + ": " + c.getContent()).toList());
    }

    private WorkOrder workOrder() {
        return tx.execute(s -> {
            WorkOrder wo = workOrderRepository.findById(workOrderId).orElseThrow();
            wo.getAssignedTo().size();
            return wo;
        });
    }

    // ─── Tests ──────────────────────────────────────────────

    @Test
    void note_isAppliedOnce_asTheAuthor() throws Exception {
        OfflineEnvelopeDTO note = op(alice, "NOTE", Map.of("text", "Compressor bearing noise"));

        List<OfflineOpResultDTO> results = upload(alice, note);

        assertEquals(APPLIED, results.get(0).getResult());
        assertEquals(opId(note), results.get(0).getOpId());
        assertEquals(List.of("Alice: [Offline update · 2026-09-21 14:14] Compressor bearing noise"), comments());
    }

    @Test
    void sameBatchAgain_isDuplicate_withNoNewSideEffects() throws Exception {
        OfflineEnvelopeDTO note = op(alice, "NOTE", Map.of("text", "first"));
        OfflineEnvelopeDTO status = op(alice, "STATUS", Map.of("base", "OPEN", "to", "ON_HOLD"));
        upload(alice, note, status);
        int webhooks = Mockito.mockingDetails(webhookDispatchService).getInvocations().size();

        List<OfflineOpResultDTO> again = upload(alice, note, status);

        assertEquals(List.of(DUPLICATE, DUPLICATE), again.stream().map(OfflineOpResultDTO::getResult).toList());
        assertEquals("APPLIED", again.get(0).getDetail());
        assertEquals(1, comments().size());
        assertEquals(webhooks, Mockito.mockingDetails(webhookDispatchService).getInvocations().size());
    }

    @Test
    void twoUploadersOfTheSameOp_oneAppliedOneDuplicate() throws Exception {
        OfflineEnvelopeDTO note = op(alice, "NOTE", Map.of("text", "handed over"));

        OfflineOpResultDTO byBob = upload(bob, note).get(0);
        OfflineOpResultDTO byAlice = upload(alice, note).get(0);

        assertEquals(APPLIED, byBob.getResult());
        assertEquals(DUPLICATE, byAlice.getResult());
        assertEquals(bob.user.getId(), byAlice.getUploadedBy());
        assertEquals(List.of("Alice: [Offline update · 2026-09-21 14:14] handed over · synced by Bob Tech"),
                comments());
    }

    @Test
    void staleStatus_isServerWinsConflict() throws Exception {
        tx.executeWithoutResult(s -> workOrderRepository.findById(workOrderId).orElseThrow()
                .setStatus(Status.COMPLETE)); // the web edit made while the phones were offline (example B)

        OfflineOpResultDTO result = upload(alice, op(alice, "STATUS", Map.of("base", "OPEN", "to", "ON_HOLD")))
                .get(0);

        assertEquals(CONFLICT, result.getResult());
        assertEquals("COMPLETE", result.getDetail());
        assertEquals(Status.COMPLETE, workOrder().getStatus());
        assertEquals(List.of("Alice: [Offline conflict · 2026-09-21 14:14] Alice Tech's offline change was not " +
                "applied: status → ON_HOLD (expected OPEN, server has COMPLETE)."), comments());
    }

    @Test
    void concurrentStatus_inOneBatch_firstAppliesSecondConflicts() throws Exception {
        OfflineEnvelopeDTO a = op(alice, "STATUS", Map.of("base", "OPEN", "to", "ON_HOLD"));
        OfflineEnvelopeDTO b = op(bob, "STATUS", Map.of("base", "OPEN", "to", "IN_PROGRESS"));

        List<OfflineOpResultDTO> results = upload(bob, b, a); // input order differs from lamport order

        assertEquals(List.of(CONFLICT, APPLIED), results.stream().map(OfflineOpResultDTO::getResult).toList());
        assertEquals(Status.ON_HOLD, workOrder().getStatus());
    }

    @Test
    void taskUpdate_compareAndSet_keepsTheOtherField() throws Exception {
        OfflineEnvelopeDTO done = op(alice, "TASK_UPDATE",
                Map.of("taskId", taskId, "field", "value", "base", "OPEN", "to", "COMPLETE"));
        OfflineEnvelopeDTO stale = op(bob, "TASK_UPDATE",
                Map.of("taskId", taskId, "field", "value", "base", "OPEN", "to", "ON_HOLD"));

        List<OfflineOpResultDTO> results = upload(alice, done, stale);

        assertEquals(List.of(APPLIED, CONFLICT), results.stream().map(OfflineOpResultDTO::getResult).toList());
        Task task = taskRepository.findById(taskId).orElseThrow();
        assertEquals("COMPLETE", task.getValue());
        assertEquals("leak check pending", task.getNotes());
    }

    @Test
    void handoffAccept_makesAcceptorPrimary_andSecondAcceptConflicts() throws Exception {
        OfflineEnvelopeDTO request = op(alice, "HANDOFF_REQUEST", Map.of("note", "bearing noise"));
        String requestOpId = opId(request);
        Map<String, Object> accept = new HashMap<>(Map.of("requestOpId", requestOpId));
        accept.put("basePrimaryUserId", alice.user.getId());
        OfflineEnvelopeDTO bobAccepts = op(bob, "HANDOFF_ACCEPT", accept);
        OfflineEnvelopeDTO carolAccepts = op(carol, "HANDOFF_ACCEPT", accept);
        tx.executeWithoutResult(s -> workOrderRepository.findById(workOrderId).orElseThrow().getAssignedTo()
                .add(userRepository.findById(carol.user.getId()).orElseThrow())); // Carol is crew for this case

        List<OfflineOpResultDTO> results = upload(bob, request, bobAccepts, carolAccepts);

        assertEquals(List.of(APPLIED, APPLIED, CONFLICT),
                results.stream().map(OfflineOpResultDTO::getResult).toList());
        WorkOrder wo = workOrder();
        assertEquals(bob.user.getId(), wo.getPrimaryUser().getId());
        assertTrue(wo.getAssignedTo().stream().anyMatch(u -> u.getId().equals(alice.user.getId())));
        assertEquals("CH-2 quarterly inspection", wo.getTitle()); // the full-copy patch kept the other fields
        assertEquals(Priority.MEDIUM, wo.getPriority());
        assertEquals(2.0, wo.getEstimatedDuration());
        List<String> comments = comments();
        assertEquals("Alice: [Offline handoff · 2026-09-21 14:14] Alice Tech requested a handoff. Note: bearing " +
                "noise · synced by Bob Tech", comments.get(0));
        assertEquals("Bob: [Offline handoff · 2026-09-21 14:15] Bob Tech accepted responsibility (requested by " +
                "Alice Tech). Primary assignee is now Bob Tech.", comments.get(1));
        assertTrue(comments.get(2).startsWith("Carol: [Offline conflict"));
    }

    @Test
    void badSignature_andNonCrewAuthor_areRejected_andStayRejected() throws Exception {
        OfflineEnvelopeDTO note = op(alice, "NOTE", Map.of("text", "original"));
        OfflineEnvelopeDTO tampered = new OfflineEnvelopeDTO(note.getBody().replace("original", "0riginal"),
                note.getSig());
        OfflineEnvelopeDTO byCarol = op(carol, "NOTE", Map.of("text", "not my work order"));

        List<OfflineOpResultDTO> first = upload(alice, tampered, byCarol);
        List<OfflineOpResultDTO> again = upload(alice, tampered, byCarol);

        assertEquals(List.of(REJECTED, REJECTED), first.stream().map(OfflineOpResultDTO::getResult).toList());
        assertEquals(List.of("bad_signature", "forbidden"),
                first.stream().map(OfflineOpResultDTO::getDetail).toList());
        assertEquals(List.of("REJECTED: bad_signature", "REJECTED: forbidden"),
                again.stream().map(OfflineOpResultDTO::getDetail).toList());
        assertTrue(comments().isEmpty());
    }
}
