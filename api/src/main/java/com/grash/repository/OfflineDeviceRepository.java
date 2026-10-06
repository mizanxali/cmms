package com.grash.repository;

import com.grash.model.OfflineDevice;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

public interface OfflineDeviceRepository extends JpaRepository<OfflineDevice, Long> {
    Optional<OfflineDevice> findByAddress(String address);

    // Scalar on purpose: loading another company's device entity would trip CompanyAudit's @PostLoad check
    @Query("select d.user.id from OfflineDevice d where d.address = :address")
    Optional<Long> findOwnerIdByAddress(@Param("address") String address);

    List<OfflineDevice> findByCompany_Id(Long companyId);
}
