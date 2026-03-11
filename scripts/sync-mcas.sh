#!/bin/bash

# sync-mcas.sh - Synchronize MCAs from files-to-mcas to mcas directory
# This script:
# 1. Copies files from files-to-mcas/ to mcas/
# 2. ALWAYS updates the catalog in MongoDB (never conditional)
# 3. Restarts affected MCAs

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
MCAS_DIR="$PROJECT_ROOT/mcas"
FILES_TO_MCAS_DIR="$PROJECT_ROOT/files-to-mcas"

# Backend configuration
BACKEND_URL="${BACKEND_URL:-http://localhost:3000}"
ADMIN_API_KEY="${ADMIN_API_KEY:-}"

# Helper functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to update MCA catalog in MongoDB
update_mca_catalog() {
    local mca_id="$1"
    local tools_file="$2"
    
    log_info "Updating catalog for MCA: $mca_id"
    
    if [[ ! -f "$tools_file" ]]; then
        log_warning "No tools.json found for $mca_id, skipping catalog update"
        return 0
    fi
    
    # Check if backend is running
    if ! curl -s "$BACKEND_URL/health" > /dev/null 2>&1; then
        log_error "Backend is not running at $BACKEND_URL"
        log_error "Please start the backend first"
        return 1
    fi
    
    # Read tools.json content
    local tools_content
    tools_content=$(cat "$tools_file")
    
    # Make API call to update catalog
    local response
    response=$(curl -s -w "%{http_code}" \
        -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $ADMIN_API_KEY" \
        -d "{\"mcaId\":\"$mca_id\",\"tools\":$tools_content}" \
        "$BACKEND_URL/api/admin/update-mca-catalog" 2>/dev/null)
    
    local http_code="${response: -3}"
    local response_body="${response%???}"
    
    if [[ "$http_code" -eq 200 ]] || [[ "$http_code" -eq 201 ]]; then
        log_success "Catalog updated for $mca_id"
        return 0
    else
        log_error "Failed to update catalog for $mca_id (HTTP $http_code)"
        if [[ -n "$response_body" ]]; then
            log_error "Response: $response_body"
        fi
        return 1
    fi
}

# Function to restart an MCA
restart_mca() {
    local mca_id="$1"
    
    log_info "Restarting MCA: $mca_id"
    
    local response
    response=$(curl -s -w "%{http_code}" \
        -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $ADMIN_API_KEY" \
        -d "{\"mcaId\":\"$mca_id\"}" \
        "$BACKEND_URL/api/admin/restart-mca" 2>/dev/null)
    
    local http_code="${response: -3}"
    local response_body="${response%???}"
    
    if [[ "$http_code" -eq 200 ]] || [[ "$http_code" -eq 201 ]]; then
        log_success "MCA restarted: $mca_id"
        return 0
    else
        log_error "Failed to restart MCA $mca_id (HTTP $http_code)"
        if [[ -n "$response_body" ]]; then
            log_error "Response: $response_body"
        fi
        return 1
    fi
}

# Main sync function
sync_mca() {
    local mca_id="$1"
    local source_dir="$FILES_TO_MCAS_DIR/$mca_id"
    local target_dir="$MCAS_DIR/$mca_id"
    
    if [[ ! -d "$source_dir" ]]; then
        log_warning "Source directory not found: $source_dir"
        return 0
    fi
    
    log_info "Syncing MCA: $mca_id"
    
    # Create target directory if it doesn't exist
    mkdir -p "$target_dir"
    
    # Copy files using rsync (preserves permissions, timestamps)
    if rsync -av --delete "$source_dir/" "$target_dir/" 2>/dev/null; then
        log_success "Files synced for $mca_id"
    else
        log_error "Failed to sync files for $mca_id"
        return 1
    fi
    
    # ALWAYS update catalog in database - this is the key fix
    update_mca_catalog "$mca_id" "$target_dir/tools.json"
    
    # Restart MCA to pick up changes
    restart_mca "$mca_id"
}

# Function to sync all MCAs
sync_all_mcas() {
    log_info "Starting full MCA synchronization"
    log_info "Source: $FILES_TO_MCAS_DIR"
    log_info "Target: $MCAS_DIR"
    
    if [[ ! -d "$FILES_TO_MCAS_DIR" ]]; then
        log_error "Source directory not found: $FILES_TO_MCAS_DIR"
        log_error "Please create the files-to-mcas directory or use --mca option"
        exit 1
    fi
    
    local total_mcas=0
    local success_mcas=0
    
    # Process each MCA directory
    for source_dir in "$FILES_TO_MCAS_DIR"/*/; do
        if [[ -d "$source_dir" ]]; then
            local mca_id
            mca_id=$(basename "$source_dir")
            
            ((total_mcas++))
            
            if sync_mca "$mca_id"; then
                ((success_mcas++))
            fi
        fi
    done
    
    log_info "Sync completed: $success_mcas/$total_mcas MCAs successful"
    
    if [[ $success_mcas -eq $total_mcas ]]; then
        log_success "All MCAs synchronized successfully!"
        return 0
    else
        log_warning "Some MCAs had issues during synchronization"
        return 1
    fi
}

# Function to sync specific MCA
sync_specific_mca() {
    local mca_id="$1"
    
    log_info "Starting synchronization for specific MCA: $mca_id"
    
    if sync_mca "$mca_id"; then
        log_success "MCA $mca_id synchronized successfully!"
        return 0
    else
        log_error "Failed to synchronize MCA $mca_id"
        return 1
    fi
}

# Function to display help
show_help() {
    cat << EOF
MCA Synchronization Script

Usage: $0 [OPTIONS]

OPTIONS:
    --mca <id>        Sync only specific MCA (by ID)
    --help, -h        Show this help message

ENVIRONMENT VARIABLES:
    BACKEND_URL       Backend URL (default: http://localhost:3000)
    ADMIN_API_KEY     Admin API key for backend authentication

DESCRIPTION:
This script synchronizes MCAs from the 'files-to-mcas' directory to the 'mcas' directory
and ALWAYS updates the catalog in MongoDB. The key difference from other sync scripts
is that this NEVER skips catalog updates - it always ensures the database reflects
the current state of tools.json files.

EXAMPLES:
    # Sync all MCAs
    $0

    # Sync specific MCA
    $0 --mca mca.linear

    # Sync with custom backend URL
    BACKEND_URL=http://localhost:4000 $0

EOF
}

# Parse command line arguments
MCA_ID=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --mca)
            MCA_ID="$2"
            shift 2
            ;;
        --help|-h)
            show_help
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
done

# Main execution
main() {
    log_info "MCA Synchronization Script Starting"
    log_info "Project Root: $PROJECT_ROOT"
    
    # Check prerequisites
    if [[ ! -d "$MCAS_DIR" ]]; then
        log_error "MCAs directory not found: $MCAS_DIR"
        exit 1
    fi
    
    if ! command -v rsync > /dev/null 2>&1; then
        log_error "rsync is required but not installed"
        exit 1
    fi
    
    if ! command -v curl > /dev/null 2>&1; then
        log_error "curl is required but not installed"
        exit 1
    fi
    
    # Execute sync based on arguments
    if [[ -n "$MCA_ID" ]]; then
        sync_specific_mca "$MCA_ID"
    else
        sync_all_mcas
    fi
}

# Run main function
main "$@"