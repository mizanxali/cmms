package com.grash.repository;

import com.grash.model.OfflineOp;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

public interface OfflineOpRepository extends JpaRepository<OfflineOp, Long> {
    Optional<OfflineOp> findByOpId(String opId);
}
