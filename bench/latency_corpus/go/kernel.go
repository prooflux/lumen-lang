// kernel.go - hand-written Go twin of kernel.lm, line-by-line, same formula/operand order.
// Must print byte-identical stdout to the Lumen twin (G9 gate).
// Single-file module (no go.mod needed for `go vet ./kernel.go` / `go build`).
package main

import (
	"fmt"
	"math"
)

func normCdf(x float64) float64 {
	ax := math.Abs(x)
	t := 1.0 / (1.0 + 0.2316419*ax)
	poly := t * (0.319381530 + t*(-0.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))))
	pdf := math.Exp(-(ax*ax)/2.0) / math.Sqrt(2.0*3.14159265358979)
	upper := 1.0 - pdf*poly
	if x < 0.0 {
		return 1.0 - upper
	}
	return upper
}

func bsCall(s, k, r, t, vol float64) float64 {
	sqt := vol * math.Sqrt(t)
	d1 := (math.Log(s/k) + (r+0.5*vol*vol)*t) / sqt
	d2 := d1 - sqt
	return s*normCdf(d1) - k*math.Exp(-(r*t))*normCdf(d2)
}

func show(p float64) {
	fmt.Printf("%.0f\n", math.Round(p*10000.0))
	fmt.Printf("\n")
}

func main() {
	show(bsCall(100.0, 100.0, 0.05, 1.0, 0.2))
	show(bsCall(100.0, 110.0, 0.05, 1.0, 0.2))
	show(bsCall(100.0, 90.0, 0.05, 0.5, 0.3))
	show(bsCall(50.0, 50.0, 0.02, 2.0, 0.25))
}
