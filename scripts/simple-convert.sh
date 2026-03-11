#!/bin/bash

# Simple SVG to PNG conversion for MCA icons
for mca_dir in mcas/mca.*/; do
    svg_file="$mca_dir/static/icon.svg"
    if [ -f "$svg_file" ]; then
        mca_id=$(basename "$mca_dir")
        echo "Converting $mca_id..."
        
        rsvg-convert \
            --width=1024 \
            --height=1024 \
            --background-color=none \
            --format=png \
            "$svg_file" \
            "$mca_dir/static/icon.png"
        
        # Update manifest
        if [ -f "$mca_dir/manifest.json" ]; then
            sed -i 's/"icon": "icon.svg"/"icon": "icon.png"/g' "$mca_dir/manifest.json"
            echo "  Updated manifest.json"
        fi
        
        echo "  ✓ $mca_id/icon.png created"
    fi
done

echo "Conversion complete!"
