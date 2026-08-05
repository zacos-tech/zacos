// ZACOS slab case — Tonverk-class, chamfered
// 11.2 x 7.1 x 2.5 in as given. All units mm. Edit the numbers; the shape follows.
// hollow=true gives an open-bottom printable shell for mockups.

L  = 11.2 * 25.4;   // length   284.48
W  = 7.1  * 25.4;   // width    180.34
H  = 2.5  * 25.4;   // height    63.50
CC = 16;            // plan corner chamfer — the brand shape
TB = 4;             // top edge bevel
BB = 2.5;           // bottom edge bevel

hollow = false;     // true -> shell with open bottom
wall   = 3;         // shell wall thickness when hollow

module plan(inset=0, cc=CC)
  polygon([
    [inset+cc, inset],       [L-inset-cc, inset],
    [L-inset,  inset+cc],    [L-inset,    W-inset-cc],
    [L-inset-cc, W-inset],   [inset+cc,   W-inset],
    [inset,    W-inset-cc],  [inset,      inset+cc]
  ]);

module slab(l=L, w=W, h=H)
  hull() {
    translate([0,0,BB]) linear_extrude(h-BB-TB) plan(0);
    translate([0,0,h-0.01]) linear_extrude(0.01) plan(TB);
    linear_extrude(0.01) plan(BB);
  }

if (hollow)
  difference() {
    slab();
    translate([0,0,-1]) linear_extrude(H-wall+1) plan(wall);
  }
else
  slab();

// the silhouette never changes.
