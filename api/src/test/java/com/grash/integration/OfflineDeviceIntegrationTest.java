package com.grash.integration;

import com.grash.dto.offline.OfflineCrewMemberDTO;
import com.grash.dto.offline.OfflineDevicePostDTO;
import com.grash.exception.CustomException;
import com.grash.model.*;
import com.grash.model.enums.*;
import com.grash.repository.*;
import com.grash.service.OfflineDeviceService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.annotation.Transactional;

import java.security.KeyPairGenerator;
import java.security.NoSuchAlgorithmException;
import java.util.*;

import static com.grash.utils.Helper.setCurrentUser;
import static org.junit.jupiter.api.Assertions.*;

@Transactional
class OfflineDeviceIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private OfflineDeviceService offlineDeviceService;
    @Autowired
    private OfflineDeviceRepository offlineDeviceRepository;
    @Autowired
    private WorkOrderRepository workOrderRepository;
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

    private User alice;
    private User bob;
    private User carol;
    private WorkOrder workOrder;

    @BeforeEach
    void setUp() {
        SubscriptionPlan plan = subscriptionPlanRepository.save(SubscriptionPlan.builder()
                .name("Test Plan").monthlyCostPerUser(10.0).yearlyCostPerUser(100.0)
                .features(new HashSet<>()).build());
        Subscription subscription = subscriptionRepository.save(Subscription.builder()
                .usersCount(5).subscriptionPlan(plan).build());
        CompanySettings settings = companySettingsRepository.save(new CompanySettings());
        Company company = new Company("OfflineCo", 10, subscription);
        company.setCompanySettings(settings);
        company = companyRepository.save(company);
        settings.setCompany(company);
        companySettingsRepository.save(settings);

        // Technician: may view and edit only work orders they are assigned to
        Role technician = roleRepository.save(Role.builder()
                .name("Technician").roleType(RoleType.ROLE_CLIENT).code(RoleCode.TECHNICIAN)
                .companySettings(settings)
                .createPermissions(new HashSet<>(List.of(PermissionEntity.WORK_ORDERS)))
                .viewPermissions(new HashSet<>(List.of(PermissionEntity.WORK_ORDERS)))
                .viewOtherPermissions(new HashSet<>())
                .editOtherPermissions(new HashSet<>())
                .deleteOtherPermissions(new HashSet<>())
                .build());

        alice = createUser("alice", technician, company);
        bob = createUser("bob", technician, company);
        carol = createUser("carol", technician, company);

        WorkOrder wo = new WorkOrder();
        wo.setTitle("CH-2 quarterly inspection");
        wo.setStatus(Status.OPEN);
        wo.setPriority(Priority.NONE);
        wo.setEstimatedDuration(1.0);
        wo.setCompany(company);
        wo.setPrimaryUser(alice);
        wo.setAssignedTo(new ArrayList<>(List.of(alice, bob)));
        wo.setCustomers(new ArrayList<>());
        wo.setFiles(new ArrayList<>());
        wo.setCustomFieldValues(new ArrayList<>());
        workOrder = workOrderRepository.saveAndFlush(wo);
    }

    private User createUser(String name, Role role, Company company) {
        User user = new User();
        user.setFirstName(name);
        user.setLastName("Tech");
        user.setEmail(name + "@offline.test");
        user.setUsername(name);
        user.setPassword("encoded");
        user.setRole(role);
        user.setCompany(company);
        user.setEnabled(true);
        user.setSuperAccountRelations(new ArrayList<>());
        user.setUserSettings(new UserSettings());
        return userRepository.save(user);
    }

    // A fresh Ed25519 key per name, so each name has its own self-certifying address
    private final Map<String, byte[]> keys = new HashMap<>();

    private byte[] key(String name) {
        return keys.computeIfAbsent(name, n -> {
            try {
                byte[] spki = KeyPairGenerator.getInstance("Ed25519").generateKeyPair().getPublic().getEncoded();
                return Arrays.copyOfRange(spki, spki.length - 32, spki.length);
            } catch (NoSuchAlgorithmException e) {
                throw new IllegalStateException(e);
            }
        });
    }

    private String address(String name) {
        return OfflineDeviceService.deriveAddress(key(name));
    }

    private OfflineDevice register(User user, String name) {
        setCurrentUser(user);
        OfflineDevicePostDTO dto = new OfflineDevicePostDTO();
        dto.setAddress(address(name));
        dto.setPublicKey(Base64.getEncoder().encodeToString(key(name)));
        return offlineDeviceService.register(dto, user);
    }

    @Test
    void deriveAddress_matchesTheSdk() {
        // A device registered by the real SDK
        byte[] key = Base64.getDecoder().decode("xRyOd2sn17UCuMhlToCnL0E4bolGlc5hKxVOxt+XjZY=");
        assertEquals("off1q9vt9yk48hn9npcfsm2hyv4tqv6a4h9vsqss2z5f", OfflineDeviceService.deriveAddress(key));
    }

    @Test
    void register_addressNotDerivedFromKey_isBadRequest() {
        setCurrentUser(alice);
        OfflineDevicePostDTO dto = new OfflineDevicePostDTO();
        dto.setAddress(address("bob"));
        dto.setPublicKey(Base64.getEncoder().encodeToString(key("alice")));

        CustomException ex = assertThrows(CustomException.class, () -> offlineDeviceService.register(dto, alice));
        assertEquals(HttpStatus.BAD_REQUEST, ex.getHttpStatus());
    }

    @Test
    void register_bindsAddressToCaller() {
        OfflineDevice device = register(alice, "alice");

        assertNotNull(device.getId());
        assertEquals(alice.getId(), device.getUser().getId());
        assertEquals(alice.getCompany().getId(), device.getCompany().getId());
    }

    @Test
    void reRegister_isIdempotent() {
        OfflineDevice first = register(alice, "alice");
        OfflineDevice second = register(alice, "alice");

        assertEquals(first.getId(), second.getId());
        assertEquals(1, offlineDeviceRepository.findByCompany_Id(alice.getCompany().getId()).size());
    }

    @Test
    void register_foreignAddress_conflicts() {
        register(alice, "alice");

        CustomException ex = assertThrows(CustomException.class, () -> register(bob, "alice"));
        assertEquals(HttpStatus.CONFLICT, ex.getHttpStatus());
    }

    @Test
    void register_badKeyLength_isBadRequest() {
        setCurrentUser(alice);
        OfflineDevicePostDTO dto = new OfflineDevicePostDTO();
        dto.setAddress(address("alice"));
        dto.setPublicKey(Base64.getEncoder().encodeToString(new byte[31]));

        CustomException ex = assertThrows(CustomException.class, () -> offlineDeviceService.register(dto, alice));
        assertEquals(HttpStatus.BAD_REQUEST, ex.getHttpStatus());
    }

    @Test
    void crew_containsAssigneesOnly() {
        register(alice, "alice");
        register(bob, "bob");
        register(carol, "carol");

        setCurrentUser(alice);
        List<OfflineCrewMemberDTO> crew = offlineDeviceService.getCrew(workOrder.getId(), alice);

        assertEquals(Set.of(address("alice"), address("bob")),
                new HashSet<>(crew.stream().map(OfflineCrewMemberDTO::getAddress).toList()));
    }

    @Test
    void crew_requiresViewAccess() {
        setCurrentUser(carol);
        CustomException ex = assertThrows(CustomException.class,
                () -> offlineDeviceService.getCrew(workOrder.getId(), carol));
        assertEquals(HttpStatus.FORBIDDEN, ex.getHttpStatus());
    }
}
