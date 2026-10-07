package com.grash.model;

import com.grash.model.abstracts.CompanyAudit;
import com.grash.model.enums.OfflineOpResult;
import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.Date;

/**
 * One uploaded offline op. The unique op_id is the dedup key; the stored result is returned for
 * every later upload of the same op.
 */
@Entity
@Data
@NoArgsConstructor
public class OfflineOp extends CompanyAudit {
    @Column(nullable = false, unique = true, length = 64)
    private String opId;

    @ManyToOne
    private WorkOrder workOrder;

    @Column(length = 32)
    private String type;

    @ManyToOne
    private User authorUser;

    @Column(length = 128)
    private String authorAddress;

    private Long lamport;

    private Date occurredAt;

    /** The exact signed body string. */
    @Column(columnDefinition = "TEXT")
    private String body;

    @Column(length = 128)
    private String sig;

    @Enumerated(EnumType.STRING)
    @Column(length = 16)
    private OfflineOpResult result;

    private String detail;

    @ManyToOne
    private User uploadedBy;
}
